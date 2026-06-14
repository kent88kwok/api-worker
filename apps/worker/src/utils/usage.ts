import {
	normalizeUsageViaWasm,
	parseUsageFromJsonViaWasm,
	parseUsageFromSseLineViaWasm,
} from "../wasm/core";
import { safeJsonParse } from "./json";
import {
	enrichNormalizedUsage,
	type NormalizedUsage as RichNormalizedUsage,
} from "./usage-normalize";

export type NormalizedUsage = RichNormalizedUsage;

export type StreamUsage = {
	usage: NormalizedUsage | null;
	firstTokenLatencyMs: number | null;
	timedOut?: boolean;
	bytesRead?: number;
	eventsSeen?: number;
	sampledPayload?: string | null;
	sampleTruncated?: boolean;
	abnormal?: StreamAbnormalSuccess | null;
};

export type StreamUsageMode = "full" | "lite" | "off";

export type StreamUsageOptions = {
	mode?: StreamUsageMode;
	timeoutMs?: number;
};

export type StreamAbnormalSuccess = {
	errorCode: string;
	errorMessage: string;
	errorMetaJson: string | null;
	eventType: string | null;
};

export type StreamUsageParseErrorCode =
	| "usage_stream_reader_failed"
	| "usage_sse_line_parse_failed"
	| "usage_sse_tail_parse_failed";

export class StreamUsageParseError extends Error {
	code: StreamUsageParseErrorCode;
	detail: string | null;
	bytesRead: number;
	eventsSeen: number;
	sampledPayload: string | null;
	sampleTruncated: boolean;

	constructor(
		code: StreamUsageParseErrorCode,
		detail?: string | null,
		context?: {
			bytesRead?: number;
			eventsSeen?: number;
			sampledPayload?: string | null;
			sampleTruncated?: boolean;
		},
	) {
		super(code);
		this.name = "StreamUsageParseError";
		this.code = code;
		this.detail = detail ?? null;
		this.bytesRead = Math.max(0, Math.floor(context?.bytesRead ?? 0));
		this.eventsSeen = Math.max(0, Math.floor(context?.eventsSeen ?? 0));
		this.sampledPayload = context?.sampledPayload ?? null;
		this.sampleTruncated = context?.sampleTruncated === true;
	}
}

const UPSTREAM_STREAM_ERROR_PAYLOAD_CODE = "upstream_stream_error_payload";
const STREAM_ERROR_DETAIL_MAX_LENGTH = 160;

function normalizeErrorDetail(error: unknown): string | null {
	if (error instanceof Error) {
		const text = error.message.trim();
		return text.length > 0 ? text : error.name;
	}
	if (typeof error === "string") {
		const text = error.trim();
		return text.length > 0 ? text : null;
	}
	return null;
}

function isAbortLikeError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const message = error.message.toLowerCase();
	return (
		error.name === "AbortError" ||
		message.includes("abort") ||
		message.includes("cancel")
	);
}

function normalizeMessage(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeSummaryDetail(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, maxLength - 1)}...`;
}

function stringifyErrorMeta(meta: Record<string, unknown>): string | null {
	try {
		return JSON.stringify(meta);
	} catch {
		return null;
	}
}

function extractStreamPayloadError(
	payload: Record<string, unknown>,
	eventType: string | null,
	context: {
		eventsSeen: number;
		bytesRead: number;
	},
): StreamAbnormalSuccess | null {
	const payloadType =
		typeof payload.type === "string" ? payload.type.trim() : null;
	const normalizedPayloadType = payloadType?.toLowerCase() ?? "";
	const normalizedEventType = eventType?.trim().toLowerCase() ?? "";
	const nestedError =
		payload.error && typeof payload.error === "object"
			? (payload.error as Record<string, unknown>)
			: null;
	const shouldTreatAsError =
		Boolean(nestedError) ||
		normalizedEventType === "error" ||
		normalizedPayloadType === "error" ||
		normalizedPayloadType === "response.failed";
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
		STREAM_ERROR_DETAIL_MAX_LENGTH,
	);
	const resolvedEventType = eventType ?? payloadType ?? null;
	return {
		errorCode: UPSTREAM_STREAM_ERROR_PAYLOAD_CODE,
		errorMessage: `${UPSTREAM_STREAM_ERROR_PAYLOAD_CODE}: status=200, event_type=${
			resolvedEventType ?? "-"
		}, code=${upstreamCode ?? "-"}, message=${summary}`,
		errorMetaJson: stringifyErrorMeta({
			type: "stream_error_payload",
			event_type: resolvedEventType,
			upstream_code: upstreamCode,
			upstream_message: normalizeMessage(upstreamMessage),
			events_seen: context.eventsSeen,
			bytes_read: context.bytesRead,
		}),
		eventType: resolvedEventType,
	};
}

function toNumber(value: unknown): number | null {
	if (value === null || value === undefined) {
		return null;
	}
	const num = Number(value);
	return Number.isFinite(num) ? num : null;
}

function pickNumber(...values: Array<unknown>): number | null {
	for (const value of values) {
		const parsed = toNumber(value);
		if (parsed !== null) {
			return parsed;
		}
	}
	return null;
}

export function normalizeUsage(raw: unknown): NormalizedUsage | null {
	return enrichNormalizedUsage(normalizeUsageViaWasm(raw), raw);
}

export function parseUsageFromJson(payload: unknown): NormalizedUsage | null {
	return enrichNormalizedUsage(parseUsageFromJsonViaWasm(payload), payload);
}

export function parseUsageFromHeaders(
	headers: Headers,
): NormalizedUsage | null {
	const jsonHeader = headers.get("x-usage") ?? headers.get("x-openai-usage");
	if (jsonHeader) {
		const parsed = safeJsonParse<unknown>(jsonHeader, null);
		const normalized = normalizeUsage(parsed);
		if (normalized) {
			return normalized;
		}
	}

	const totalTokens = pickNumber(
		headers.get("x-usage-total-tokens"),
		headers.get("x-openai-usage-total-tokens"),
	);
	const promptTokens = pickNumber(
		headers.get("x-usage-prompt-tokens"),
		headers.get("x-openai-usage-prompt-tokens"),
	);
	const completionTokens = pickNumber(
		headers.get("x-usage-completion-tokens"),
		headers.get("x-openai-usage-completion-tokens"),
	);

	if (
		totalTokens === null &&
		promptTokens === null &&
		completionTokens === null
	) {
		return null;
	}

	return {
		totalTokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
		promptTokens: promptTokens ?? 0,
		completionTokens: completionTokens ?? 0,
		cacheReadInputTokens: 0,
		cacheWriteInputTokens: 0,
		uncachedInputTokens: promptTokens ?? 0,
	};
}

export async function parseUsageFromSse(
	response: Response,
	options: StreamUsageOptions = {},
): Promise<StreamUsage> {
	if (!response.body) {
		return {
			usage: null,
			firstTokenLatencyMs: null,
			timedOut: false,
			abnormal: null,
		};
	}
	const mode: StreamUsageMode = options.mode ?? "full";
	if (mode === "off") {
		return {
			usage: null,
			firstTokenLatencyMs: null,
			timedOut: false,
			abnormal: null,
		};
	}
	const reader = response.body.getReader();
	const timeoutMs =
		typeof options.timeoutMs === "number" && options.timeoutMs > 0
			? Math.floor(options.timeoutMs)
			: 0;
	let timedOut = false;
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	if (timeoutMs > 0) {
		timeoutId = setTimeout(() => {
			timedOut = true;
			reader.cancel().catch(() => undefined);
		}, timeoutMs);
	}
	const decoder = new TextDecoder();
	let buffer = "";
	let usage: NormalizedUsage | null = null;
	let abnormal: StreamAbnormalSuccess | null = null;
	const start = Date.now();
	let firstTokenLatencyMs: number | null = null;
	let bytesRead = 0;
	let eventsSeen = 0;
	let currentEventType: string | null = null;
	const sampleLimit = 2048;
	let sampledPayload = "";
	let sampleTruncated = false;
	const appendSample = (payload: string): void => {
		if (!payload || sampleTruncated) {
			return;
		}
		const chunk = payload.length > 240 ? `${payload.slice(0, 240)}…` : payload;
		const prefix = sampledPayload.length > 0 ? "\n" : "";
		const remaining = sampleLimit - sampledPayload.length;
		if (remaining <= 0) {
			sampleTruncated = true;
			return;
		}
		const nextChunk = `${prefix}${chunk}`;
		if (nextChunk.length > remaining) {
			sampledPayload += nextChunk.slice(0, remaining);
			sampleTruncated = true;
			return;
		}
		sampledPayload += nextChunk;
		if (sampledPayload.length >= sampleLimit) {
			sampleTruncated = true;
		}
	};
	try {
		while (true) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await reader.read();
			} catch (error) {
				if (timedOut || isAbortLikeError(error)) {
					break;
				}
				throw new StreamUsageParseError(
					"usage_stream_reader_failed",
					normalizeErrorDetail(error),
					{
						bytesRead,
						eventsSeen,
						sampledPayload: sampledPayload || null,
						sampleTruncated,
					},
				);
			}
			const { done, value } = chunk;
			if (done) {
				break;
			}
			bytesRead += value?.byteLength ?? 0;
			buffer += decoder.decode(value, { stream: true });
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const rawLine = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				const line = rawLine.trim();
				if (!line) {
					currentEventType = null;
					newlineIndex = buffer.indexOf("\n");
					continue;
				}
				if (line.startsWith("event:")) {
					const nextEventType = line.slice(6).trim();
					currentEventType = nextEventType || null;
					newlineIndex = buffer.indexOf("\n");
					continue;
				}
				if (line.startsWith("data:")) {
					const payload = line.slice(5).trim();
					if (payload && payload !== "[DONE]") {
						eventsSeen += 1;
						appendSample(payload);
						if (firstTokenLatencyMs === null) {
							firstTokenLatencyMs = Date.now() - start;
						}
						const parsedPayload = safeJsonParse<Record<string, unknown> | null>(
							payload,
							null,
						);
						if (
							parsedPayload &&
							typeof parsedPayload === "object" &&
							!Array.isArray(parsedPayload)
						) {
							abnormal = extractStreamPayloadError(
								parsedPayload,
								currentEventType,
								{
									eventsSeen,
									bytesRead,
								},
							);
							if (abnormal) {
								return {
									usage,
									firstTokenLatencyMs,
									timedOut,
									bytesRead,
									eventsSeen,
									sampledPayload: sampledPayload || null,
									sampleTruncated,
									abnormal,
								};
							}
						}
						let wasmCandidate = null;
						try {
							wasmCandidate = parseUsageFromSseLineViaWasm(line);
						} catch (error) {
							throw new StreamUsageParseError(
								"usage_sse_line_parse_failed",
								normalizeErrorDetail(error),
								{
									bytesRead,
									eventsSeen,
									sampledPayload: sampledPayload || null,
									sampleTruncated,
								},
							);
						}
						if (wasmCandidate) {
							usage = enrichNormalizedUsage(wasmCandidate, parsedPayload);
							newlineIndex = buffer.indexOf("\n");
							continue;
						}
					}
				}
				newlineIndex = buffer.indexOf("\n");
			}
		}

		const remaining = buffer.trim();
		if (remaining.startsWith("data:")) {
			const payload = remaining.slice(5).trim();
			if (payload && payload !== "[DONE]") {
				eventsSeen += 1;
				appendSample(payload);
				if (firstTokenLatencyMs === null) {
					firstTokenLatencyMs = Date.now() - start;
				}
				const parsedPayload = safeJsonParse<Record<string, unknown> | null>(
					payload,
					null,
				);
				if (
					parsedPayload &&
					typeof parsedPayload === "object" &&
					!Array.isArray(parsedPayload)
				) {
					abnormal = extractStreamPayloadError(
						parsedPayload,
						currentEventType,
						{
							eventsSeen,
							bytesRead,
						},
					);
					if (abnormal) {
						return {
							usage,
							firstTokenLatencyMs,
							timedOut,
							bytesRead,
							eventsSeen,
							sampledPayload: sampledPayload || null,
							sampleTruncated,
							abnormal,
						};
					}
				}
				let wasmCandidate = null;
				try {
					wasmCandidate = parseUsageFromSseLineViaWasm(remaining);
				} catch (error) {
					throw new StreamUsageParseError(
						"usage_sse_tail_parse_failed",
						normalizeErrorDetail(error),
						{
							bytesRead,
							eventsSeen,
							sampledPayload: sampledPayload || null,
							sampleTruncated,
						},
					);
				}
				if (wasmCandidate) {
					usage = enrichNormalizedUsage(wasmCandidate, parsedPayload);
					return {
						usage,
						firstTokenLatencyMs,
						timedOut,
						bytesRead,
						eventsSeen,
						sampledPayload: sampledPayload || null,
						sampleTruncated,
						abnormal,
					};
				}
			}
		}

		return {
			usage,
			firstTokenLatencyMs,
			timedOut,
			bytesRead,
			eventsSeen,
			sampledPayload: sampledPayload || null,
			sampleTruncated,
			abnormal,
		};
	} finally {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
		await reader.cancel().catch(() => undefined);
		try {
			reader.releaseLock();
		} catch {
			// ignore release errors from already-closed readers
		}
	}
}
