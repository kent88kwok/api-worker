import type { D1Database } from "@cloudflare/workers-types";
import { safeJsonParse } from "../../utils/json";
import type { ChannelRow } from "./types";
import { extractModelIds, type ModelEntry } from "./models";
import { listVerifiedModelsByChannel } from "./model-capabilities";
import { deriveCanonicalModel } from "../../services/model-normalization";

type ManualModelConfig = {
	include: string[];
	exclude: string[];
};

export type ManualModelStatus = "manual" | "excluded" | "auto";

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
		exclude: removeModel(manual.exclude, canonicalModel),
	};

	if (update.status === "manual") {
		next.include = appendModel(next.include, canonicalModel);
	}
	if (update.status === "excluded") {
		next.exclude = appendModel(next.exclude, canonicalModel);
	}

	setModelList(metadata, MANUAL_INCLUDE_KEY, next.include);
	delete metadata[MANUAL_PENDING_KEY];
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
	if (manual.include.includes(normalized)) {
		return "manual";
	}
	return "auto";
}

export function stageNewlyDiscoveredModels(
	metadataJson: string | null | undefined,
	_previousModels: string[],
	discoveredModels: string[],
): string | null {
	const discoveredModelList = normalizeModelList(discoveredModels);
	const discoveredSet = new Set(discoveredModelList);
	const initialManual = parseManualModelConfig(metadataJson);
	const metadata = safeJsonParse<Record<string, unknown>>(metadataJson, {});
	const nextInclude = initialManual.include.filter(
		(model) => !discoveredSet.has(model),
	);
	setModelList(metadata, MANUAL_INCLUDE_KEY, nextInclude);
	delete metadata[MANUAL_PENDING_KEY];
	setModelList(metadata, MANUAL_EXCLUDE_KEY, initialManual.exclude);
	return stringifyMetadata(metadata);
}

export function resolveEffectiveModelIds({
	channel,
	verifiedModels,
}: EffectiveModelInput): string[] {
	const manual = parseManualModelConfig(channel.metadata_json);
	const blocked = new Set(manual.exclude);
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
	for (const model of extractModelIds(channel)) {
		addIfAllowed(model);
	}
	for (const model of manual.include) {
		addIfAllowed(model);
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
