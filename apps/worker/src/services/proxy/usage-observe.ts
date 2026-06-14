import { invalidateSelectionHotCache } from "../hot-kv";
import {
	extractJsonErrorPayload,
	hasMeaningfulErrorField,
} from "../proxy-error-parser";
import { processUsageEvent, type UsageEvent } from "../usage-events";
import { safeJsonParse } from "../../utils/json";
import { StreamUsageParseError } from "../../utils/usage";
import type { AppEnv } from "../../env";
import {
	formatUsageErrorMessage,
	normalizeMessage,
	normalizeSummaryDetail,
	type ExecutionContextLike,
	scheduleDbWrite,
	stringifyErrorMeta,
} from "./shared";

const STREAM_USAGE_UNKNOWN_PARSE_ERROR_CODE =
	"usage_stream_parse_unknown_error";
const STREAM_USAGE_NON_ERROR_THROWN_CODE =
	"usage_stream_parse_non_error_thrown";
export const ABNORMAL_SUCCESS_RESPONSE_ERROR_CODE = "abnormal_success_response";
const UPSTREAM_STREAM_ERROR_PAYLOAD_CODE = "upstream_stream_error_payload";

export type AbnormalSuccessDetails = {
	errorCode: string;
	errorMessage: string;
	errorMetaJson: string | null;
};

export function hasUsageHeaders(headers: Headers): boolean {
	const candidates = [
		"x-usage",
		"x-openai-usage",
		"x-usage-total-tokens",
		"x-openai-usage-total-tokens",
		"x-usage-prompt-tokens",
		"x-openai-usage-prompt-tokens",
		"x-usage-completion-tokens",
		"x-openai-usage-completion-tokens",
	];
	return candidates.some((name) => {
		const value = headers.get(name);
		return typeof value === "string" && value.trim().length > 0;
	});
}

export function hasUsageJsonHint(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") {
		return false;
	}
	const record = payload as Record<string, unknown>;
	return (
		record.usage !== undefined ||
		record.usageMetadata !== undefined ||
		record.usage_metadata !== undefined
	);
}

export function transformOpenAiStreamOptions(
	bodyText: string | undefined,
	mode: "inject" | "strip",
): {
	bodyText: string | undefined;
	injected: boolean;
	stripped: boolean;
} {
	if (!bodyText) {
		return { bodyText, injected: false, stripped: false };
	}
	const body = safeJsonParse<Record<string, unknown> | null>(bodyText, null);
	if (!body || typeof body !== "object") {
		return { bodyText, injected: false, stripped: false };
	}
	if (mode === "strip") {
		if (!("stream_options" in body)) {
			return { bodyText, injected: false, stripped: false };
		}
		const nextBody = { ...body };
		delete nextBody.stream_options;
		return {
			bodyText: JSON.stringify(nextBody),
			injected: false,
			stripped: true,
		};
	}
	const streamOptions = body.stream_options;
	let injected = false;
	const nextBody = { ...body };
	if (!streamOptions || typeof streamOptions !== "object") {
		nextBody.stream_options = { include_usage: true };
		injected = true;
	} else {
		const mapped = { ...(streamOptions as Record<string, unknown>) };
		if (mapped.include_usage !== true) {
			mapped.include_usage = true;
			injected = true;
		}
		nextBody.stream_options = mapped;
	}
	return {
		bodyText: JSON.stringify(nextBody),
		injected,
		stripped: false,
	};
}

export function classifyStreamUsageParseError(
	error: unknown,
	maxLength: number,
): {
	errorCode: string;
	errorMessage: string;
	errorMetaJson: string | null;
} {
	if (error instanceof StreamUsageParseError) {
		return {
			errorCode: error.code,
			errorMessage: formatUsageErrorMessage(
				error.code,
				error.detail,
				maxLength,
			),
			errorMetaJson: stringifyErrorMeta({
				type: "stream_usage_parse_error",
				code: error.code,
				detail: normalizeMessage(error.detail),
				bytes_read: error.bytesRead,
				events_seen: error.eventsSeen,
				sampled_payload: error.sampledPayload,
				sample_truncated: error.sampleTruncated,
			}),
		};
	}
	if (error instanceof Error) {
		const errorCode = STREAM_USAGE_UNKNOWN_PARSE_ERROR_CODE;
		return {
			errorCode,
			errorMessage: formatUsageErrorMessage(
				errorCode,
				normalizeMessage(error.message) ?? error.name,
				maxLength,
			),
			errorMetaJson: stringifyErrorMeta({
				type: "stream_usage_parse_error",
				code: errorCode,
				detail: normalizeMessage(error.message) ?? error.name,
			}),
		};
	}
	const errorCode = STREAM_USAGE_NON_ERROR_THROWN_CODE;
	return {
		errorCode,
		errorMessage: errorCode,
		errorMetaJson: stringifyErrorMeta({
			type: "stream_usage_parse_error",
			code: errorCode,
		}),
	};
}

export function createUsageEventScheduler(c: {
	env: AppEnv["Bindings"];
	executionCtx?: ExecutionContextLike;
}): (event: UsageEvent) => void {
	return (event: UsageEvent) => {
		const task = processUsageEvent(c.env.DB, event)
			.then((result) => {
				if (!result.channelDisabled) {
					return;
				}
				return invalidateSelectionHotCache(c.env.KV_HOT);
			})
			.catch(() => undefined);
		scheduleDbWrite(c, task);
	};
}

export async function detectAbnormalSuccessResponse(
	response: Response,
): Promise<AbnormalSuccessDetails | null> {
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) {
		return null;
	}
	const payload = await response
		.clone()
		.json()
		.catch(() => null);
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return null;
	}
	const record = payload as Record<string, unknown>;
	if (!hasMeaningfulErrorField(record)) {
		return null;
	}
	const details = extractJsonErrorPayload(record, response.status, {
		contentType,
	});
	const normalizedCode = normalizeMessage(details.errorCode);
	const finalErrorCode = normalizedCode ?? ABNORMAL_SUCCESS_RESPONSE_ERROR_CODE;
	const finalErrorMessage =
		normalizeMessage(details.errorMessage) ?? finalErrorCode;
	return {
		errorCode: finalErrorCode,
		errorMessage: finalErrorMessage,
		errorMetaJson: details.errorMetaJson,
	};
}

function extractStreamPayloadError(
	payload: Record<string, unknown>,
	context: {
		eventsSeen: number;
		bytesRead: number;
	},
): AbnormalSuccessDetails | null {
	const typeValue =
		typeof payload.type === "string" ? payload.type.trim() : null;
	const normalizedType = typeValue?.toLowerCase() ?? "";
	const nestedError =
		payload.error && typeof payload.error === "object"
			? (payload.error as Record<string, unknown>)
			: null;
	const shouldTreatAsError =
		Boolean(nestedError) ||
		normalizedType === "error" ||
		normalizedType === "response.failed";
	if (!shouldTreatAsError) {
		return null;
	}
	const upstreamCode =
		typeof nestedError?.code === "string"
			? nestedError.code
			: typeof nestedError?.type === "string"
				? nestedError.type
				: typeof payload.code === "string"
					? payload.code
					: null;
	const upstreamMessage =
		typeof nestedError?.message === "string"
			? nestedError.message
			: typeof payload.message === "string"
				? payload.message
				: null;
	const summary = normalizeSummaryDetail(
		normalizeMessage(upstreamMessage) ?? "-",
		240,
	);
	return {
		errorCode: UPSTREAM_STREAM_ERROR_PAYLOAD_CODE,
		errorMessage: `${UPSTREAM_STREAM_ERROR_PAYLOAD_CODE}: status=200, event_type=${
			typeValue ?? "-"
		}, code=${upstreamCode ?? "-"}, message=${summary}`,
		errorMetaJson: stringifyErrorMeta({
			type: "stream_error_payload",
			event_type: typeValue ?? null,
			upstream_code: upstreamCode ?? null,
			upstream_message: normalizeMessage(upstreamMessage),
			events_seen: context.eventsSeen,
			bytes_read: context.bytesRead,
		}),
	};
}

export async function detectAbnormalStreamSuccessResponse(
	response: Response,
): Promise<AbnormalSuccessDetails | null> {
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("text/event-stream")) {
		return null;
	}
	const cloned = response.clone();
	if (!cloned.body) {
		return null;
	}
	const reader = cloned.body.getReader();
	const decoder = new TextDecoder();
	const maxProbeEvents = 2;
	const maxProbeBytes = 32 * 1024;
	const probeTimeoutMs = 300;
	let timedOut = false;
	let bytesRead = 0;
	let eventsSeen = 0;
	let buffer = "";
	const probeTimer = setTimeout(() => {
		timedOut = true;
		reader.cancel().catch(() => undefined);
	}, probeTimeoutMs);
	try {
		while (
			!timedOut &&
			eventsSeen < maxProbeEvents &&
			bytesRead < maxProbeBytes
		) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await reader.read();
			} catch {
				break;
			}
			const { done, value } = chunk;
			if (done) {
				break;
			}
			bytesRead += value?.byteLength ?? 0;
			buffer += decoder.decode(value, { stream: true });
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (!line.startsWith("data:")) {
					newlineIndex = buffer.indexOf("\n");
					continue;
				}
				const payloadText = line.slice(5).trim();
				if (!payloadText || payloadText === "[DONE]") {
					newlineIndex = buffer.indexOf("\n");
					continue;
				}
				eventsSeen += 1;
				const payload = safeJsonParse<Record<string, unknown> | null>(
					payloadText,
					null,
				);
				if (payload && typeof payload === "object" && !Array.isArray(payload)) {
					const abnormal = extractStreamPayloadError(payload, {
						eventsSeen,
						bytesRead,
					});
					if (abnormal) {
						return abnormal;
					}
				}
				if (eventsSeen >= maxProbeEvents) {
					break;
				}
				newlineIndex = buffer.indexOf("\n");
			}
		}
		return null;
	} finally {
		clearTimeout(probeTimer);
		await reader.cancel().catch(() => undefined);
		try {
			reader.releaseLock();
		} catch {
			// ignore release errors from already-closed readers
		}
	}
}
