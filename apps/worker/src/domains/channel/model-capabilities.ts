import type { D1Database } from "@cloudflare/workers-types";
import { nowIso } from "../../utils/time";
import type { ModelEntry } from "./models";
import { extractModelIds } from "./models";
import {
	deriveCanonicalModel,
	toCanonicalModelSet,
} from "../../services/model-normalization";

export type CapabilityRow = {
	channel_id: string;
	model: string;
	canonical_model?: string | null;
	last_ok_at: number | null;
	last_err_count?: number | null;
	cooldown_count?: number | null;
};

export type ChannelModelCooldownSummary = {
	channel_id: string;
	model: string;
	canonical_model?: string | null;
	last_ok_at: number | null;
	last_err_at: number;
	last_err_code: string | null;
	last_err_count: number;
	cooldown_count: number;
	remaining_seconds: number;
};

type ChannelModelCooldownState = {
	lastOkAt: number;
	lastErrAt: number;
	lastErrCount: number;
};

type RecordModelErrorOptions = {
	cooldownSeconds: number;
	cooldownFailureThreshold: number;
};

export type RecordModelErrorResult = {
	cooldownEntered: boolean;
	cooldownCount: number;
	channelDisabled: boolean;
};

type RecordChannelDisableOptions = {
	disableDurationSeconds: number;
	disableThreshold: number;
};

const MAX_SQL_BINDINGS = 90;

export type RecordChannelDisableResult = {
	channelTempDisabled: boolean;
	channelDisabled: boolean;
	hitCount: number;
};

export function resolveChannelDisableState(
	hitCount: number,
	options: RecordChannelDisableOptions,
	nowSeconds: number,
): {
	channelTempDisabled: boolean;
	channelDisabled: boolean;
	autoDisabledUntil: number | null;
} {
	const disableDurationSeconds = Math.max(
		0,
		Math.floor(options.disableDurationSeconds),
	);
	const disableThreshold = Math.max(1, Math.floor(options.disableThreshold));
	if (hitCount >= disableThreshold) {
		return {
			channelTempDisabled: false,
			channelDisabled: true,
			autoDisabledUntil: null,
		};
	}
	const autoDisabledUntil =
		disableDurationSeconds > 0 ? nowSeconds + disableDurationSeconds : null;
	return {
		channelTempDisabled: autoDisabledUntil !== null,
		channelDisabled: false,
		autoDisabledUntil,
	};
}

function toSafeInt(value: unknown): number {
	const parsed = Number(value ?? 0);
	if (!Number.isFinite(parsed)) {
		return 0;
	}
	return Math.max(0, Math.floor(parsed));
}

function chunkStrings(items: string[], size: number): string[][] {
	const chunks: string[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

function isCoolingDown(
	state: ChannelModelCooldownState,
	nowSeconds: number,
	cooldownSeconds: number,
	cooldownFailureThreshold: number,
): boolean {
	if (cooldownSeconds <= 0) {
		return false;
	}
	const cutoff = nowSeconds - cooldownSeconds;
	return (
		state.lastErrAt > 0 &&
		state.lastErrAt >= cutoff &&
		state.lastErrAt >= state.lastOkAt &&
		state.lastErrCount >= cooldownFailureThreshold
	);
}

export function buildCapabilityMap(
	rows: CapabilityRow[],
): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	for (const row of rows) {
		const capabilityModel = deriveCanonicalModel(
			row.canonical_model ?? row.model,
		);
		if (!row.channel_id || !capabilityModel) {
			continue;
		}
		const lastOk = Number(row.last_ok_at ?? 0);
		if (!lastOk || lastOk <= 0) {
			continue;
		}
		const set = map.get(row.channel_id) ?? new Set<string>();
		set.add(capabilityModel);
		map.set(row.channel_id, set);
	}
	return map;
}

export async function listVerifiedModelsByChannel(
	db: D1Database,
	channelIds: string[],
): Promise<Map<string, Set<string>>> {
	if (channelIds.length === 0) {
		return new Map();
	}
	const rows: CapabilityRow[] = [];
	for (const chunk of chunkStrings(channelIds, MAX_SQL_BINDINGS)) {
		const placeholders = chunk.map(() => "?").join(", ");
		const result = await db
			.prepare(
				`SELECT channel_id, model, canonical_model, last_ok_at FROM channel_model_capabilities WHERE channel_id IN (${placeholders}) AND last_ok_at > 0`,
			)
			.bind(...chunk)
			.all<CapabilityRow>();
		rows.push(...(result.results ?? []));
	}
	return buildCapabilityMap(rows);
}

export async function listVerifiedModelEntries(
	db: D1Database,
	channels: Array<{ id: string; name: string }>,
): Promise<ModelEntry[]> {
	const ids = channels.map((channel) => channel.id);
	const nameMap = new Map(
		channels.map((channel) => [channel.id, channel.name]),
	);
	const map = await listVerifiedModelsByChannel(db, ids);
	const entries: ModelEntry[] = [];
	for (const [channelId, models] of map.entries()) {
		const channelName = nameMap.get(channelId) ?? channelId;
		for (const id of models) {
			entries.push({ id, label: id, channelId, channelName });
		}
	}
	return entries;
}

export async function listModelsByChannelWithFallback(
	db: D1Database,
	channels: Array<{ id: string; name: string; models_json?: string | null }>,
): Promise<Map<string, Set<string>>> {
	const ids = channels.map((channel) => channel.id);
	const verified = await listVerifiedModelsByChannel(db, ids);
	const map = new Map<string, Set<string>>();
	for (const channel of channels) {
		const verifiedModels = verified.get(channel.id);
		if (verifiedModels && verifiedModels.size > 0) {
			map.set(channel.id, new Set(verifiedModels));
			continue;
		}
		const declaredModels = Array.from(
			toCanonicalModelSet(extractModelIds(channel)),
		);
		if (declaredModels.length > 0) {
			map.set(channel.id, new Set(declaredModels));
		}
	}
	return map;
}

export async function listModelEntriesWithFallback(
	db: D1Database,
	channels: Array<{ id: string; name: string; models_json?: string | null }>,
): Promise<ModelEntry[]> {
	const map = await listModelsByChannelWithFallback(db, channels);
	const entries: ModelEntry[] = [];
	for (const channel of channels) {
		const models = map.get(channel.id);
		if (!models) {
			continue;
		}
		for (const id of models) {
			entries.push({
				id,
				label: id,
				channelId: channel.id,
				channelName: channel.name,
			});
		}
	}
	return entries;
}

export async function listCoolingDownChannelsForModel(
	db: D1Database,
	channelIds: string[],
	model: string | null,
	cooldownSeconds: number,
	minErrorCount: number = 1,
): Promise<Set<string>> {
	const canonicalModel = deriveCanonicalModel(model);
	if (!canonicalModel || channelIds.length === 0 || cooldownSeconds <= 0) {
		return new Set();
	}
	const now = Math.floor(Date.now() / 1000);
	const cutoff = now - cooldownSeconds;
	const rows: Array<{
		channel_id: string;
		last_err_at: number | null;
		last_ok_at: number | null;
		last_err_count?: number | null;
	}> = [];
	for (const chunk of chunkStrings(channelIds, MAX_SQL_BINDINGS - 2)) {
		const placeholders = chunk.map(() => "?").join(", ");
		const result = await db
			.prepare(
				`SELECT channel_id, last_err_at, last_ok_at, last_err_count FROM channel_model_capabilities WHERE canonical_model = ? AND channel_id IN (${placeholders}) AND last_err_at IS NOT NULL AND last_err_at >= ?`,
			)
			.bind(canonicalModel, ...chunk, cutoff)
			.all<{
				channel_id: string;
				last_err_at: number | null;
				last_ok_at: number | null;
				last_err_count?: number | null;
			}>();
		rows.push(...(result.results ?? []));
	}
	const blocked = new Set<string>();
	for (const row of rows) {
		const lastErr = Number(row.last_err_at ?? 0);
		const lastOk = Number(row.last_ok_at ?? 0);
		const errCount = Number(row.last_err_count ?? 0);
		if (lastErr && lastErr >= lastOk && errCount >= minErrorCount) {
			blocked.add(row.channel_id);
		}
	}
	return blocked;
}

export async function listCoolingDownModelEntriesByChannel(
	db: D1Database,
	channelIds: string[],
	cooldownSeconds: number,
	minErrorCount: number = 1,
): Promise<Map<string, ChannelModelCooldownSummary[]>> {
	if (channelIds.length === 0 || cooldownSeconds <= 0) {
		return new Map();
	}
	const now = Math.floor(Date.now() / 1000);
	const cutoff = now - cooldownSeconds;
	const rows: Array<{
		channel_id: string;
		model: string;
		canonical_model?: string | null;
		last_ok_at: number | null;
		last_err_at: number | null;
		last_err_code: string | null;
		last_err_count: number | null;
		cooldown_count: number | null;
	}> = [];
	for (const chunk of chunkStrings(channelIds, MAX_SQL_BINDINGS - 1)) {
		const placeholders = chunk.map(() => "?").join(", ");
		const result = await db
			.prepare(
				`SELECT channel_id, model, canonical_model, last_ok_at, last_err_at, last_err_code, last_err_count, cooldown_count
				 FROM channel_model_capabilities
				 WHERE channel_id IN (${placeholders})
				   AND last_err_at IS NOT NULL
				   AND last_err_at >= ?`,
			)
			.bind(...chunk, cutoff)
			.all<{
				channel_id: string;
				model: string;
				last_ok_at: number | null;
				last_err_at: number | null;
				last_err_code: string | null;
				last_err_count: number | null;
				cooldown_count: number | null;
			}>();
		rows.push(...(result.results ?? []));
	}
	const grouped = new Map<string, ChannelModelCooldownSummary[]>();
	for (const row of rows) {
		const lastErrAt = toSafeInt(row.last_err_at);
		const lastOkAt = toSafeInt(row.last_ok_at);
		const lastErrCount = toSafeInt(row.last_err_count);
		if (
			!lastErrAt ||
			lastErrAt < cutoff ||
			lastErrAt < lastOkAt ||
			lastErrCount < minErrorCount
		) {
			continue;
		}
		const remainingSeconds = Math.max(0, cooldownSeconds - (now - lastErrAt));
		if (remainingSeconds <= 0) {
			continue;
		}
		const entry: ChannelModelCooldownSummary = {
			channel_id: row.channel_id,
			model: row.model,
			canonical_model: row.canonical_model ?? deriveCanonicalModel(row.model),
			last_ok_at: Number(row.last_ok_at ?? 0) || null,
			last_err_at: lastErrAt,
			last_err_code: row.last_err_code ?? null,
			last_err_count: lastErrCount,
			cooldown_count: toSafeInt(row.cooldown_count),
			remaining_seconds: remainingSeconds,
		};
		const list = grouped.get(row.channel_id) ?? [];
		list.push(entry);
		grouped.set(row.channel_id, list);
	}
	for (const [channelId, entries] of grouped.entries()) {
		entries.sort((left, right) => {
			if (right.remaining_seconds !== left.remaining_seconds) {
				return right.remaining_seconds - left.remaining_seconds;
			}
			if (right.last_err_count !== left.last_err_count) {
				return right.last_err_count - left.last_err_count;
			}
			return left.model.localeCompare(right.model);
		});
		grouped.set(channelId, entries);
	}
	return grouped;
}

export async function recordChannelModelError(
	db: D1Database,
	channelId: string,
	model: string | null,
	errorCode: string,
	options: RecordModelErrorOptions,
	nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<RecordModelErrorResult> {
	const canonicalModel = deriveCanonicalModel(model);
	if (!canonicalModel) {
		return {
			cooldownEntered: false,
			cooldownCount: 0,
			channelDisabled: false,
		};
	}
	const cooldownSeconds = Math.max(0, Math.floor(options.cooldownSeconds));
	const cooldownFailureThreshold = Math.max(
		1,
		Math.floor(options.cooldownFailureThreshold),
	);
	const timestamp = nowIso();
	const row = await db
		.prepare(
			"SELECT last_ok_at, last_err_at, last_err_count, cooldown_count FROM channel_model_capabilities WHERE channel_id = ? AND canonical_model = ?",
		)
		.bind(channelId, canonicalModel)
		.first<{
			last_ok_at: number | null;
			last_err_at: number | null;
			last_err_count: number | null;
			cooldown_count?: number | null;
		}>();
	const lastOkAt = toSafeInt(row?.last_ok_at);
	const lastErrAt = toSafeInt(row?.last_err_at);
	const lastErrCount = toSafeInt(row?.last_err_count);
	const cooldownCount = toSafeInt(row?.cooldown_count);
	const wasCooling = isCoolingDown(
		{
			lastOkAt,
			lastErrAt,
			lastErrCount,
		},
		nowSeconds,
		cooldownSeconds,
		cooldownFailureThreshold,
	);
	const nextErrCount = row ? lastErrCount + 1 : 1;
	const isCoolingNow = isCoolingDown(
		{
			lastOkAt,
			lastErrAt: nowSeconds,
			lastErrCount: nextErrCount,
		},
		nowSeconds,
		cooldownSeconds,
		cooldownFailureThreshold,
	);
	const cooldownEntered = !wasCooling && isCoolingNow;
	const nextCooldownCount = cooldownEntered ? cooldownCount + 1 : cooldownCount;
	if (row) {
		await db
			.prepare(
				"UPDATE channel_model_capabilities SET last_err_at = ?, last_err_code = ?, last_err_count = ?, cooldown_count = ?, updated_at = ? WHERE channel_id = ? AND canonical_model = ?",
			)
			.bind(
				nowSeconds,
				errorCode,
				nextErrCount,
				nextCooldownCount,
				timestamp,
				channelId,
				canonicalModel,
			)
			.run();
	} else {
		await db
			.prepare(
				"INSERT INTO channel_model_capabilities (channel_id, model, canonical_model, last_ok_at, last_err_at, last_err_code, last_err_count, cooldown_count, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, 1, ?, ?, ?)",
			)
			.bind(
				channelId,
				canonicalModel,
				canonicalModel,
				nowSeconds,
				errorCode,
				nextCooldownCount,
				timestamp,
				timestamp,
			)
			.run();
	}
	return {
		cooldownEntered,
		cooldownCount: nextCooldownCount,
		channelDisabled: false,
	};
}

export async function clearChannelModelCooldown(
	db: D1Database,
	channelId: string,
	model: string | null,
): Promise<boolean> {
	if (!model) {
		return false;
	}
	const normalizedModel = deriveCanonicalModel(model);
	if (!normalizedModel) {
		return false;
	}
	const result = await db
		.prepare(
			"UPDATE channel_model_capabilities SET last_err_at = NULL, last_err_code = NULL, last_err_count = 0, updated_at = ? WHERE channel_id = ? AND canonical_model = ?",
		)
		.bind(nowIso(), channelId, normalizedModel)
		.run();
	return Number(result.meta?.changes ?? 0) > 0;
}

export async function deleteChannelModelCapability(
	db: D1Database,
	channelId: string,
	model: string | null,
): Promise<boolean> {
	if (!model) {
		return false;
	}
	const normalizedModel = deriveCanonicalModel(model);
	if (!normalizedModel) {
		return false;
	}
	const result = await db
		.prepare(
			"DELETE FROM channel_model_capabilities WHERE channel_id = ? AND canonical_model = ?",
		)
		.bind(channelId, normalizedModel)
		.run();
	return Number(result.meta?.changes ?? 0) > 0;
}

export async function recordChannelDisableHit(
	db: D1Database,
	channelId: string,
	errorCode: string,
	options: RecordChannelDisableOptions,
	nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<RecordChannelDisableResult> {
	const disableDurationSeconds = Math.max(
		0,
		Math.floor(options.disableDurationSeconds),
	);
	const disableThreshold = Math.max(1, Math.floor(options.disableThreshold));
	const timestamp = nowIso();
	const incrementResult = await db
		.prepare(
			"UPDATE channels SET auto_disable_hit_count = COALESCE(auto_disable_hit_count, 0) + 1, auto_disabled_reason_code = ?, updated_at = ? WHERE id = ? AND status = ? AND COALESCE(auto_disabled_permanent, 0) = 0",
		)
		.bind(errorCode, timestamp, channelId, "active")
		.run();
	if (Number(incrementResult.meta?.changes ?? 0) === 0) {
		const existing = await db
			.prepare(
				"SELECT status, auto_disable_hit_count, auto_disabled_permanent FROM channels WHERE id = ?",
			)
			.bind(channelId)
			.first<{
				status: string | null;
				auto_disable_hit_count: number | null;
				auto_disabled_permanent: number | null;
			}>();
		const existingHitCount = toSafeInt(existing?.auto_disable_hit_count);
		const existingDisabled =
			toSafeInt(existing?.auto_disabled_permanent) > 0 ||
			String(existing?.status ?? "") === "disabled";
		return {
			channelTempDisabled: false,
			channelDisabled: existingDisabled,
			hitCount: existingHitCount,
		};
	}

	const row = await db
		.prepare(
			"SELECT auto_disable_hit_count, auto_disabled_permanent FROM channels WHERE id = ? AND status = ?",
		)
		.bind(channelId, "active")
		.first<{
			auto_disable_hit_count: number | null;
			auto_disabled_permanent: number | null;
		}>();
	const nextHitCount = toSafeInt(row?.auto_disable_hit_count);
	if (toSafeInt(row?.auto_disabled_permanent) > 0) {
		return {
			channelTempDisabled: false,
			channelDisabled: true,
			hitCount: nextHitCount,
		};
	}
	const nextState = resolveChannelDisableState(
		nextHitCount,
		{
			disableDurationSeconds,
			disableThreshold,
		},
		nowSeconds,
	);
	const updateResult = nextState.channelDisabled
		? await db
				.prepare(
					"UPDATE channels SET status = ?, auto_disabled_until = NULL, auto_disabled_reason_code = ?, auto_disabled_permanent = 0, updated_at = ? WHERE id = ? AND status = ?",
				)
				.bind("disabled", errorCode, timestamp, channelId, "active")
				.run()
		: await db
				.prepare(
					"UPDATE channels SET auto_disabled_until = ?, auto_disabled_reason_code = ?, auto_disabled_permanent = 0, updated_at = ? WHERE id = ? AND status = ? AND COALESCE(auto_disabled_permanent, 0) = 0",
				)
				.bind(
					nextState.autoDisabledUntil,
					errorCode,
					timestamp,
					channelId,
					"active",
				)
				.run();
	return {
		channelTempDisabled:
			Number(updateResult.meta?.changes ?? 0) > 0 &&
			nextState.channelTempDisabled,
		channelDisabled:
			Number(updateResult.meta?.changes ?? 0) > 0 && nextState.channelDisabled,
		hitCount: nextHitCount,
	};
}

export async function upsertChannelModelCapabilities(
	db: D1Database,
	channelId: string,
	models: string[],
	nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<void> {
	if (models.length === 0) {
		return;
	}
	const timestamp = nowIso();
	const canonicalModels = Array.from(toCanonicalModelSet(models));
	const stmt = db.prepare(
		"INSERT INTO channel_model_capabilities (channel_id, model, canonical_model, last_ok_at, last_err_at, last_err_code, last_err_count, cooldown_count, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, 0, 0, ?, ?) ON CONFLICT(channel_id, model) DO UPDATE SET canonical_model = excluded.canonical_model, last_ok_at = excluded.last_ok_at, last_err_at = NULL, last_err_code = NULL, last_err_count = 0, cooldown_count = 0, updated_at = excluded.updated_at",
	);
	const statements = canonicalModels.map((model) =>
		stmt.bind(channelId, model, model, nowSeconds, timestamp, timestamp),
	);
	for (let index = 0; index < statements.length; index += MAX_SQL_BINDINGS) {
		await db.batch(statements.slice(index, index + MAX_SQL_BINDINGS));
	}

	// Clean up stale models that are no longer supported by the upstream channel
	const existingRows = await db
		.prepare(
			"SELECT canonical_model as model FROM channel_model_capabilities WHERE channel_id = ?",
		)
		.bind(channelId)
		.all<{ model: string }>();
	const nextModelSet = new Set(canonicalModels);
	const staleModels = (existingRows.results ?? [])
		.map((row) => row.model)
		.filter((model) => !nextModelSet.has(model));
	for (const chunk of chunkStrings(staleModels, MAX_SQL_BINDINGS - 1)) {
		const placeholders = chunk.map(() => "?").join(", ");
		await db
			.prepare(
				`DELETE FROM channel_model_capabilities WHERE channel_id = ? AND model IN (${placeholders})`,
			)
			.bind(channelId, ...chunk)
			.run();
	}

	await db
		.prepare(
			"UPDATE channels SET auto_disable_hit_count = 0, auto_disabled_until = NULL, auto_disabled_reason_code = NULL, auto_disabled_permanent = 0, updated_at = ? WHERE id = ? AND status = ?",
		)
		.bind(timestamp, channelId, "active")
		.run();
}
