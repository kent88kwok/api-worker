import {
	canonicalModelEquals,
	deriveCanonicalModel,
} from "../model-normalization";
import type { ModelPriceRecord } from "./types";

function normalizeModel(value: string | null | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

function modelPatternMatches(
	pattern: string,
	model: string | null | undefined,
): boolean {
	const normalizedPattern = normalizeModel(pattern);
	const normalizedModel = normalizeModel(model);
	if (!normalizedPattern || !normalizedModel) {
		return false;
	}
	if (!normalizedPattern.includes("*")) {
		return normalizedPattern === normalizedModel;
	}
	const escaped = normalizedPattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "i").test(normalizedModel);
}

function manualPriceMatchesKnownModel(
	price: ModelPriceRecord,
	knownModels: string[],
): boolean {
	return knownModels.some((knownModel) => {
		if (
			price.canonical_model &&
			canonicalModelEquals(price.canonical_model, knownModel)
		) {
			return true;
		}
		if (modelPatternMatches(price.model_pattern, knownModel)) {
			return true;
		}
		const knownCanonical = deriveCanonicalModel(knownModel);
		if (
			knownCanonical &&
			modelPatternMatches(price.model_pattern, knownCanonical)
		) {
			return true;
		}
		return false;
	});
}

export function planOrphanManualPrices(input: {
	prices: ModelPriceRecord[];
	knownModels: string[];
}): ModelPriceRecord[] {
	return input.prices.filter((price) => {
		if (price.source !== "manual") {
			return false;
		}
		return !manualPriceMatchesKnownModel(price, input.knownModels);
	});
}
