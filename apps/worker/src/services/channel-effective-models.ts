import type { D1Database } from "@cloudflare/workers-types";
import { safeJsonParse } from "../utils/json";
import type { ChannelRow } from "./channel-types";
import { extractModelIds, type ModelEntry } from "./channel-models";
import { listVerifiedModelsByChannel } from "./channel-model-capabilities";
import {
	deriveCanonicalModel,
	toCanonicalModelSet,
} from "./model-normalization";

type ManualModelConfig = {
	include: string[];
	pending: string[];
	exclude: string[];
};

export type ManualModelStatus = "enabled" | "pending" | "excluded" | "auto";

type EffectiveModelInput = {
	channel: Pick<ChannelRow, "models_json" | "metadata_json">;
	verifiedModels?: Set<string> | string[] | null;
};

const MANUAL_INCLUDE_KEY = "manual_include_models";
const MANUAL_PENDING_KEY = "manual_pending_models";
const MANUAL_EXCLUDE_KEY = "manual_exclude_models";

function appendUnique(
	output: string[],
	seen: Set<string>,
	value: unknown,
): void {
	const normalized = deriveCanonicalModel(String(value ?? "").trim());
	if (!normalized || seen.has(normalized)) {
		return;
	}
	seen.add(normalized);
	output.push(normalized);
}

function normalizeModelList(value: unknown): string[] {
	const output: string[] = [];
	const seen = new Set<string>();
	if (Array.isArray(value)) {
		for (const item of value) {
			appendUnique(output, seen, item);
		}
		return output;
	}
	if (typeof value === "string") {
		for (const item of value.split(/[\n,]/)) {
			appendUnique(output, seen, item);
		}
	}
	return output;
}

export function parseManualModelConfig(
	metadataJson: string | null | undefined,
): ManualModelConfig {
	const metadata = safeJsonParse<Record<string, unknown>>(metadataJson, {});
	return {
		include: normalizeModelList(metadata[MANUAL_INCLUDE_KEY]),
		pending: normalizeModelList(metadata[MANUAL_PENDING_KEY]),
		exclude: normalizeModelList(metadata[MANUAL_EXCLUDE_KEY]),
	};
}

function setModelList(
	metadata: Record<string, unknown>,
	key: string,
	models: string[],
): void {
	if (models.length > 0) {
		metadata[key] = models;
		return;
	}
	delete metadata[key];
}

function removeModel(models: string[], model: string): string[] {
	const canonicalModel = deriveCanonicalModel(model) ?? model;
	return models.filter((item) => item !== canonicalModel);
}

function appendModel(models: string[], model: string): string[] {
	const output = removeModel(models, model);
	const canonicalModel = deriveCanonicalModel(model) ?? model;
	output.push(canonicalModel);
	return output;
}

function stringifyMetadata(metadata: Record<string, unknown>): string | null {
	return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
}

export function updateManualModelStatus(
	metadataJson: string | null | undefined,
	update: {
		model: string;
		status: ManualModelStatus;
	},
): string | null {
	const model = String(update.model ?? "").trim();
	if (!model) {
		return metadataJson ?? null;
	}
	const canonicalModel = deriveCanonicalModel(model) ?? model;
	const metadata = safeJsonParse<Record<string, unknown>>(metadataJson, {});
	const manual = parseManualModelConfig(metadataJson);
	const next = {
		include: removeModel(manual.include, canonicalModel),
		pending: removeModel(manual.pending, canonicalModel),
		exclude: removeModel(manual.exclude, canonicalModel),
	};

	if (update.status === "enabled") {
		next.include = appendModel(next.include, canonicalModel);
	}
	if (update.status === "pending") {
		next.pending = appendModel(next.pending, canonicalModel);
	}
	if (update.status === "excluded") {
		next.exclude = appendModel(next.exclude, canonicalModel);
	}

	setModelList(metadata, MANUAL_INCLUDE_KEY, next.include);
	setModelList(metadata, MANUAL_PENDING_KEY, next.pending);
	setModelList(metadata, MANUAL_EXCLUDE_KEY, next.exclude);
	return stringifyMetadata(metadata);
}

export function resolveChannelModelStatus(
	metadataJson: string | null | undefined,
	model: string,
): ManualModelStatus {
	const normalized = deriveCanonicalModel(model);
	if (!normalized) {
		return "auto";
	}
	const manual = parseManualModelConfig(metadataJson);
	if (manual.exclude.includes(normalized)) {
		return "excluded";
	}
	if (manual.pending.includes(normalized)) {
		return "pending";
	}
	if (manual.include.includes(normalized)) {
		return "enabled";
	}
	return "auto";
}

export function stageNewlyDiscoveredModels(
	metadataJson: string | null | undefined,
	previousModels: string[],
	discoveredModels: string[],
): string | null {
	let metadata = metadataJson ?? null;
	const previousModelList = normalizeModelList(previousModels);
	const previousSet = new Set(previousModelList);
	const discoveredModelList = normalizeModelList(discoveredModels);
	const discoveredSet = new Set(discoveredModelList);
	const initialManual = parseManualModelConfig(metadataJson);
	const shouldPromoteFirstDiscovery =
		previousModelList.length === 0 &&
		initialManual.include.length === 0 &&
		initialManual.pending.length === 0 &&
		initialManual.exclude.length === 0;
	const nextInclude = initialManual.include.filter((model) =>
		discoveredSet.has(model),
	);
	if (nextInclude.length !== initialManual.include.length) {
		const metadataObject = safeJsonParse<Record<string, unknown>>(metadata, {});
		setModelList(metadataObject, MANUAL_INCLUDE_KEY, nextInclude);
		setModelList(metadataObject, MANUAL_PENDING_KEY, initialManual.pending);
		setModelList(metadataObject, MANUAL_EXCLUDE_KEY, initialManual.exclude);
		metadata = stringifyMetadata(metadataObject);
	}
	for (const model of discoveredModelList) {
		if (previousSet.has(model)) {
			continue;
		}
		const status = resolveChannelModelStatus(metadata, model);
		if (status !== "auto") {
			continue;
		}
		metadata = updateManualModelStatus(metadata, {
			model,
			status: shouldPromoteFirstDiscovery ? "enabled" : "pending",
		});
	}
	return metadata;
}

export function resolveEffectiveModelIds({
	channel,
	verifiedModels,
}: EffectiveModelInput): string[] {
	const manual = parseManualModelConfig(channel.metadata_json);
	const blocked = new Set([...manual.pending, ...manual.exclude]);
	const output: string[] = [];
	const seen = new Set<string>();
	const addIfAllowed = (model: unknown) => {
		const normalized = deriveCanonicalModel(String(model ?? "").trim());
		if (!normalized || blocked.has(normalized)) {
			return;
		}
		appendUnique(output, seen, normalized);
	};

	const verified = Array.isArray(verifiedModels)
		? verifiedModels
		: Array.from(verifiedModels ?? []);
	for (const model of verified) {
		addIfAllowed(model);
	}
	for (const model of manual.include) {
		addIfAllowed(model);
	}

	if (
		verified.length === 0 &&
		manual.include.length === 0 &&
		manual.pending.length === 0 &&
		manual.exclude.length === 0
	) {
		for (const model of extractModelIds(channel)) {
			addIfAllowed(model);
		}
	}

	return output;
}

export async function listEffectiveModelsByChannel(
	db: D1Database,
	channels: Array<Pick<ChannelRow, "id" | "models_json" | "metadata_json">>,
): Promise<Map<string, Set<string>>> {
	const ids = channels.map((channel) => channel.id);
	const verified = await listVerifiedModelsByChannel(db, ids);
	const map = new Map<string, Set<string>>();
	for (const channel of channels) {
		map.set(
			channel.id,
			new Set(
				resolveEffectiveModelIds({
					channel,
					verifiedModels: verified.get(channel.id) ?? new Set<string>(),
				}),
			),
		);
	}
	return map;
}

export async function listEffectiveModelEntries(
	db: D1Database,
	channels: Array<
		Pick<ChannelRow, "id" | "name" | "models_json" | "metadata_json">
	>,
): Promise<ModelEntry[]> {
	const map = await listEffectiveModelsByChannel(db, channels);
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
