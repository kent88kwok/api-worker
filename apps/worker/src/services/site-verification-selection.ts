import { selectTokenForModel } from "../domains/channel/attemptability";
import {
	parseManualModelConfig,
	resolveEffectiveModelIds,
} from "../domains/channel/effective-models";
import type { ChannelRow } from "../domains/channel/types";
import { extractModelIds } from "../domains/channel/models";
import type { ChannelTokenTestItem } from "../domains/channel/testing";
import { deriveCanonicalModel } from "./model-normalization";
import { safeJsonParse } from "../utils/json";

export type VerificationTokenSelectionInput = {
	id?: string;
	name?: string;
	api_key: string;
	models_json?: string | null;
};

export type VerificationModelSelection = {
	model: string | null;
	source: string;
	all: string[];
};

function parseRawTokenModelIds(raw: string | null | undefined): string[] {
	const parsed = safeJsonParse<unknown>(raw, []);
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed
		.map((item) => String(item ?? "").trim())
		.filter((item) => item.length > 0);
}

function pickRandomItem<T>(items: T[], random: () => number): T | null {
	if (items.length === 0) {
		return null;
	}
	const index = Math.floor(random() * items.length);
	return items[index] ?? items[0] ?? null;
}

export function mergeVerificationTokenModels(
	tokens: VerificationTokenSelectionInput[],
	tokenResults: ChannelTokenTestItem[],
): VerificationTokenSelectionInput[] {
	const modelsByTokenId = new Map<string, string[]>();
	for (const item of tokenResults) {
		if (!item.ok || !item.tokenId || item.models.length === 0) {
			continue;
		}
		modelsByTokenId.set(item.tokenId, item.models);
	}
	return tokens.map((token) => {
		if (!token.id) {
			return token;
		}
		const discoveredModels = modelsByTokenId.get(token.id);
		if (!discoveredModels) {
			return token;
		}
		return {
			...token,
			models_json: JSON.stringify(discoveredModels),
		};
	});
}

export function collectCandidateModels(options: {
	channel: Pick<ChannelRow, "models_json" | "metadata_json">;
	tokens: VerificationTokenSelectionInput[];
	discoveredModels: string[];
	mappedDefaultModel: string | null;
	lastVerifiedModel: string | null;
	random?: () => number;
}): VerificationModelSelection {
	const random = options.random ?? Math.random;
	const rawCandidates: Array<{ model: string; source: string }> = [];
	const excludedModels = new Set(
		parseManualModelConfig(options.channel.metadata_json).exclude,
	);
	const appendCandidate = (model: string | null, source: string) => {
		const canonicalModel = deriveCanonicalModel(model);
		if (!canonicalModel || excludedModels.has(canonicalModel)) {
			return;
		}
		rawCandidates.push({
			model: canonicalModel,
			source,
		});
	};
	appendCandidate(options.lastVerifiedModel, "last_verified_model");
	appendCandidate(options.mappedDefaultModel, "model_mapping_default");
	for (const model of resolveEffectiveModelIds({
		channel: options.channel,
		verifiedModels: options.discoveredModels,
	})) {
		appendCandidate(model, "effective_models");
	}
	const seenModels = new Set<string>();
	const candidates = rawCandidates.filter((candidate) => {
		if (!candidate.model || seenModels.has(candidate.model)) {
			return false;
		}
		seenModels.add(candidate.model);
		return true;
	});
	const all = candidates.map((candidate) => candidate.model);
	const routableCandidates = candidates.filter((candidate) =>
		Boolean(selectTokenForModel(options.tokens, candidate.model).token),
	);
	const selectedCandidate = pickRandomItem(routableCandidates, random);
	if (selectedCandidate) {
		return {
			model: selectedCandidate.model,
			source: selectedCandidate.source,
			all,
		};
	}
	if (all.length > 0) {
		return { model: null, source: "no_matching_call_token", all };
	}
	return { model: null, source: "missing_model", all };
}

export function resolveVerificationRequestModels(options: {
	model: string | null;
	tokenModelsJson?: string | null;
	channelModelsJson?: string | null;
}): string[] {
	const canonicalModel = deriveCanonicalModel(options.model);
	if (!canonicalModel) {
		return [];
	}

	const tokenCandidates = parseRawTokenModelIds(options.tokenModelsJson);
	const channelCandidates = extractModelIds({
		models_json: options.channelModelsJson,
	});
	const collectMatches = (candidates: string[]): string[] => {
		const ordered = new Set<string>();
		for (const candidate of candidates) {
			if (deriveCanonicalModel(candidate) !== canonicalModel) {
				continue;
			}
			ordered.add(candidate);
		}
		return Array.from(ordered);
	};
	const tokenMatches = collectMatches(tokenCandidates);
	if (tokenCandidates.length > 0) {
		return tokenMatches;
	}
	return collectMatches(channelCandidates);
}

export function buildVerificationModelAttemptOrder(
	selectedModel: string | null,
	allModels: string[],
	maxModels?: number,
): string[] {
	const ordered = new Set<string>();
	const append = (value: string | null) => {
		const normalized = String(value ?? "").trim();
		if (!normalized) {
			return;
		}
		ordered.add(normalized);
	};
	append(selectedModel);
	for (const model of allModels) {
		append(model);
	}
	const orderedModels = Array.from(ordered);
	if (maxModels === undefined || !Number.isFinite(maxModels) || maxModels < 1) {
		return orderedModels;
	}
	return orderedModels.slice(0, Math.floor(maxModels));
}
