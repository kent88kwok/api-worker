import { selectTokenForModel } from "./channel-attemptability";
import {
	parseManualModelConfig,
	resolveEffectiveModelIds,
} from "./channel-effective-models";
import type { ChannelRow } from "./channel-types";
import type { ChannelTokenTestItem } from "./channel-testing";

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
		if (!model || excludedModels.has(model)) {
			return;
		}
		rawCandidates.push({
			model,
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
