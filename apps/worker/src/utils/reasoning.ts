type ReasoningInput = Record<string, unknown>;

function readEffort(value: unknown): string | number | null {
	if (typeof value === "string" || typeof value === "number") {
		return value;
	}
	return null;
}

function readObject(value: unknown): ReasoningInput | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as ReasoningInput)
		: null;
}

function readBudgetEffort(value: unknown): string | null {
	const budget =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: Number.NaN;
	if (!Number.isFinite(budget)) {
		return null;
	}
	if (budget <= 0) {
		return "none";
	}
	if (budget < 2048) {
		return "low";
	}
	if (budget < 8192) {
		return "medium";
	}
	return "high";
}

/**
 * Extracts reasoning effort from request payloads.
 *
 * Args:
 *   input: Request body payload.
 *
 * Returns:
 *   Reasoning effort value, if present.
 */
export function extractReasoningEffort(input: unknown): string | number | null {
	if (!input || typeof input !== "object") {
		return null;
	}
	const body = input as ReasoningInput;
	const direct = readEffort(body.reasoning_effort ?? body.reasoningEffort);
	if (direct !== null) {
		return direct;
	}
	const reasoning = body.reasoning;
	if (typeof reasoning === "string" || typeof reasoning === "number") {
		return reasoning;
	}
	const reasoningObj = readObject(reasoning);
	if (reasoningObj) {
		const effort = readEffort(reasoningObj.effort);
		if (effort !== null) {
			return effort;
		}
	}
	const outputConfig = readObject(body.output_config ?? body.outputConfig);
	const outputConfigEffort = readEffort(outputConfig?.effort);
	if (outputConfigEffort !== null) {
		return outputConfigEffort;
	}
	const thinking = readObject(body.thinking);
	const thinkingEffort = readEffort(thinking?.effort);
	if (thinkingEffort !== null) {
		return thinkingEffort;
	}
	const thinkingType = readEffort(thinking?.type);
	if (
		typeof thinkingType === "string" &&
		thinkingType.trim().toLowerCase() === "disabled"
	) {
		return "none";
	}
	return readBudgetEffort(thinking?.budget_tokens ?? thinking?.budgetTokens);
}
