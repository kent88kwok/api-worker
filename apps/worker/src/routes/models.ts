import { Hono } from "hono";
import type { AppEnv, Bindings } from "../env";
import {
	parseManualModelConfig,
	resolveChannelModelStatus,
	updateManualModelStatus,
	type ManualModelStatus,
} from "../services/channel-effective-models";
import {
	deleteChannelModelCapability,
	listVerifiedModelsByChannel,
} from "../services/channel-model-capabilities";
import {
	extractModelIds,
	removeModelFromModelsJson,
} from "../services/channel-models";
import {
	getChannelById,
	listChannels,
	updateChannel,
} from "../services/channel-repo";
import {
	buildModelsIndexKey,
	invalidateSelectionHotCache,
	readHotJson,
	writeHotJson,
} from "../services/hot-kv";
import { triggerBackupAfterDataChange } from "../services/backup-auto-sync";
import { jsonError } from "../utils/http";
import { nowIso } from "../utils/time";

const models = new Hono<AppEnv>();

type ModelChannelStatus = "enabled" | "pending" | "excluded";

type ModelsPayload = {
	models: Array<{
		id: string;
		counts: {
			enabled: number;
			pending: number;
			excluded: number;
		};
		channels: Array<{
			id: string;
			name: string;
			status: ModelChannelStatus;
		}>;
	}>;
};

function normalizeManagedStatus(
	status: ManualModelStatus,
	isVerified: boolean,
): ModelChannelStatus | null {
	if (status === "excluded") {
		return "excluded";
	}
	if (status === "pending") {
		return "pending";
	}
	if (status === "enabled" || isVerified) {
		return "enabled";
	}
	return null;
}

function addModelChannel(
	map: Map<string, ModelsPayload["models"][number]>,
	model: string,
	channel: { id: string; name: string },
	status: ModelChannelStatus,
): void {
	const existing = map.get(model) ?? {
		id: model,
		counts: {
			enabled: 0,
			pending: 0,
			excluded: 0,
		},
		channels: [],
	};
	if (
		existing.channels.some(
			(item) => item.id === channel.id && item.status === status,
		)
	) {
		return;
	}
	existing.channels.push({
		id: channel.id,
		name: channel.name,
		status,
	});
	existing.counts[status] += 1;
	map.set(model, existing);
}

async function buildModelsPayload(db: Bindings["DB"]): Promise<ModelsPayload> {
	const channels = await listChannels(db, {
		orderBy: "created_at",
		order: "DESC",
	});
	const activeChannelIds = channels
		.filter((channel) => channel.status === "active")
		.map((channel) => channel.id);
	const verified = await listVerifiedModelsByChannel(db, activeChannelIds);
	const map = new Map<string, ModelsPayload["models"][number]>();

	for (const channel of channels) {
		const manual = parseManualModelConfig(channel.metadata_json);
		const candidates = new Set<string>([
			...extractModelIds(channel),
			...(verified.get(channel.id) ?? new Set<string>()),
			...manual.include,
			...manual.pending,
			...manual.exclude,
		]);
		for (const model of candidates) {
			const status = normalizeManagedStatus(
				resolveChannelModelStatus(channel.metadata_json, model),
				verified.get(channel.id)?.has(model) ?? false,
			);
			if (!status) {
				continue;
			}
			addModelChannel(map, model, channel, status);
		}
	}

	const payload = {
		models: Array.from(map.values()).sort((left, right) =>
			left.id.localeCompare(right.id),
		),
	};
	for (const model of payload.models) {
		model.channels.sort((left, right) => {
			const statusOrder = { enabled: 0, pending: 1, excluded: 2 };
			const statusDelta = statusOrder[left.status] - statusOrder[right.status];
			if (statusDelta !== 0) {
				return statusDelta;
			}
			return left.name.localeCompare(right.name);
		});
	}
	return payload;
}

/**
 * Returns aggregated models from all channels.
 */
models.get("/", async (c) => {
	const db = c.env.DB;
	const cacheKey = buildModelsIndexKey();
	const cached = await readHotJson<ModelsPayload>(c.env.KV_HOT, cacheKey);
	if (cached && Array.isArray(cached.models)) {
		return c.json(cached);
	}

	const payload = await buildModelsPayload(db);
	void writeHotJson(c.env.KV_HOT, cacheKey, payload, 120);
	return c.json(payload);
});

models.post("/status", async (c) => {
	const body = (await c.req.json().catch(() => null)) as {
		channel_id?: string;
		model?: string;
		status?: ManualModelStatus;
	} | null;
	const channelId = String(body?.channel_id ?? "").trim();
	const model = String(body?.model ?? "").trim();
	const status = body?.status;
	if (!channelId || !model || !status) {
		return jsonError(c, 400, "missing_model_status", "missing_model_status");
	}
	if (!["enabled", "pending", "excluded", "auto"].includes(status)) {
		return jsonError(c, 400, "invalid_model_status", "invalid_model_status");
	}
	const channel = await getChannelById(c.env.DB, channelId);
	if (!channel) {
		return jsonError(c, 404, "channel_not_found", "channel_not_found");
	}
	const metadataJson = updateManualModelStatus(channel.metadata_json, {
		model,
		status,
	});
	const modelsJson =
		status === "auto"
			? removeModelFromModelsJson(channel.models_json, model)
			: (channel.models_json ?? "[]");
	if (status === "auto") {
		await deleteChannelModelCapability(c.env.DB, channel.id, model);
	}
	await updateChannel(c.env.DB, channel.id, {
		name: channel.name,
		base_url: channel.base_url,
		api_key: channel.api_key,
		weight: Number(channel.weight ?? 1),
		status: channel.status,
		rate_limit: channel.rate_limit ?? 0,
		models_json: modelsJson,
		type: channel.type ?? 1,
		group_name: channel.group_name ?? null,
		priority: channel.priority ?? 0,
		metadata_json: metadataJson,
		system_token: channel.system_token ?? null,
		system_userid: channel.system_userid ?? null,
		checkin_enabled: channel.checkin_enabled ?? 0,
		checkin_url: channel.checkin_url ?? null,
		last_checkin_date: channel.last_checkin_date ?? null,
		last_checkin_status: channel.last_checkin_status ?? null,
		last_checkin_message: channel.last_checkin_message ?? null,
		last_checkin_at: channel.last_checkin_at ?? null,
		updated_at: nowIso(),
	});
	await triggerBackupAfterDataChange(c.env.DB);
	await invalidateSelectionHotCache(c.env.KV_HOT);
	return c.json({
		ok: true,
		model,
		channel_id: channel.id,
		status,
	});
});

export default models;
