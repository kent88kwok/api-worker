import { safeJsonParse } from "../utils/json";

const UPSTREAM_ERROR_DETAIL_MAX_LENGTH = 240;

export type ParsedErrorDetails = {
	errorCode: string | null;
	errorMessage: string | null;
	errorMetaJson: string | null;
};

export function hasMeaningfulErrorField(
	payload: Record<string, unknown>,
): boolean {
	if (!("error" in payload)) {
		return false;
	}
	const error = payload.error;
	if (error === null || error === undefined) {
		return false;
	}
	if (typeof error === "string") {
		return error.trim().length > 0;
	}
	if (Array.isArray(error)) {
		return error.length > 0;
	}
	if (typeof error === "object") {
		return Object.keys(error as Record<string, unknown>).length > 0;
	}
	if (typeof error === "boolean") {
		return error;
	}
	return true;
}

function normalizeMessage(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringField(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeSummaryDetail(value: string, maxLength: number): string {
	const normalized = value.trim();
	if (!normalized) {
		return "-";
	}
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function redactHeaderValue(key: string, value: string): string {
	const normalizedKey = key.trim().toLowerCase();
	if (
		normalizedKey === "authorization" ||
		normalizedKey === "x-api-key" ||
		normalizedKey === "x-goog-api-key" ||
		normalizedKey === "proxy-authorization"
	) {
		return "[redacted]";
	}
	return value;
}

function snapshotHeaders(headers: Headers): Record<string, string> {
	const entries = Array.from(headers.entries()).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	return Object.fromEntries(
		entries.map(([key, value]) => [key, redactHeaderValue(key, value)]),
	);
}

function extractEmbeddedHttpStatus(text: string): {
	statusLine: string | null;
	statusCode: number | null;
	statusText: string | null;
} {
	const match = text.match(
		/^(HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s+([^\r\n]+))?)/m,
	);
	if (!match) {
		return {
			statusLine: null,
			statusCode: null,
			statusText: null,
		};
	}
	const parsedStatus = Number(match[2] ?? "");
	return {
		statusLine: match[1] ?? null,
		statusCode: Number.isInteger(parsedStatus) ? parsedStatus : null,
		statusText: normalizeStringField(match[3] ?? null),
	};
}

function isLikelyHtmlPayload(value: string): boolean {
	return (
		/<!doctype\s+html/i.test(value) ||
		/<html[\s>]/i.test(value) ||
		/<head[\s>]/i.test(value) ||
		/<body[\s>]/i.test(value)
	);
}

function summarizeHtmlErrorPayload(html: string, statusHint: number): string {
	const title = normalizeStringField(
		html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? null,
	);
	const headline = normalizeStringField(
		html.match(/<h1[^>]*>([^<]+)<\/h1>/i)?.[1] ?? null,
	);
	return `upstream_html_error_page: status=${statusHint}, title=${title ?? "-"}, headline=${headline ?? "-"}`;
}

function stringifyErrorMeta(meta: Record<string, unknown>): string | null {
	try {
		return JSON.stringify(meta);
	} catch {
		return null;
	}
}

function isJsonLikeContentType(contentType: string): boolean {
	return /json/i.test(contentType);
}

function isProblemJsonContentType(contentType: string): boolean {
	return /application\/problem\+json/i.test(contentType);
}

function isLikelyBinaryContentType(contentType: string): boolean {
	const normalized = contentType.toLowerCase();
	return (
		normalized.includes("application/octet-stream") ||
		normalized.startsWith("image/") ||
		normalized.startsWith("audio/") ||
		normalized.startsWith("video/") ||
		normalized.includes("application/pdf") ||
		normalized.includes("application/zip")
	);
}

function looksTextualPayload(decoded: string): boolean {
	const sample = decoded.slice(0, 512);
	if (!sample.trim()) {
		return false;
	}
	if (
		sample.trimStart().startsWith("{") ||
		sample.trimStart().startsWith("[") ||
		sample.trimStart().startsWith("<") ||
		sample.trimStart().startsWith("data:") ||
		sample.includes("HTTP/")
	) {
		return true;
	}
	let suspicious = 0;
	for (const char of sample) {
		const code = char.charCodeAt(0);
		const isControl =
			(code >= 0 && code < 9) || (code > 13 && code < 32) || code === 65533;
		if (isControl) {
			suspicious += 1;
		}
	}
	return suspicious <= Math.max(2, Math.floor(sample.length * 0.05));
}

function extractSseJsonPayload(text: string): Record<string, unknown> | null {
	const frames = text.split(/\r?\n\r?\n/u);
	for (const frame of frames) {
		const dataLines = frame
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.filter((line) => line.length > 0 && line !== "[DONE]");
		if (dataLines.length === 0) {
			continue;
		}
		const payload = safeJsonParse<Record<string, unknown> | null>(
			dataLines.join("\n"),
			null,
		);
		if (payload && typeof payload === "object" && !Array.isArray(payload)) {
			return payload;
		}
	}
	return null;
}

export function extractJsonErrorPayload(
	payload: Record<string, unknown>,
	status: number,
	options?: {
		contentType?: string | null;
	},
): ParsedErrorDetails {
	const raw = payload as Record<string, unknown>;
	const error =
		raw.error && typeof raw.error === "object" && !Array.isArray(raw.error)
			? (raw.error as Record<string, unknown>)
			: raw;
	const contentType = options?.contentType ?? null;
	const problemType =
		typeof error.type === "string"
			? error.type
			: typeof raw.type === "string"
				? raw.type
				: null;
	const isProblemJson = isProblemJsonContentType(contentType ?? "");
	const errorCode =
		typeof error.code === "string"
			? error.code
			: typeof raw.code === "string"
				? raw.code
				: !isProblemJson &&
						typeof error.type === "string" &&
						error.type !== "about:blank"
					? error.type
					: !isProblemJson &&
							typeof raw.type === "string" &&
							raw.type !== "about:blank"
						? raw.type
						: null;
	const problemTitle =
		typeof error.title === "string"
			? error.title
			: typeof raw.title === "string"
				? raw.title
				: null;
	const problemDetail =
		typeof error.detail === "string"
			? error.detail
			: typeof raw.detail === "string"
				? raw.detail
				: null;
	const errorMessage =
		typeof error.message === "string"
			? error.message
			: typeof raw.message === "string"
				? raw.message
				: (problemDetail ?? problemTitle);
	const param =
		typeof error.param === "string"
			? error.param
			: typeof raw.param === "string"
				? raw.param
				: null;
	const normalizedErrorMessage = normalizeMessage(errorMessage);
	return {
		errorCode,
		errorMessage: `upstream_json_error: status=${status}, code=${errorCode ?? "-"}, message=${
			normalizedErrorMessage
				? normalizeSummaryDetail(
						normalizedErrorMessage,
						UPSTREAM_ERROR_DETAIL_MAX_LENGTH,
					)
				: "-"
		}`,
		errorMetaJson: stringifyErrorMeta({
			type: "json_error",
			param,
			status,
			problem_type: problemType,
			problem_title: problemTitle,
			problem_detail: problemDetail,
		}),
	};
}

export async function extractErrorDetails(
	response: Response,
): Promise<ParsedErrorDetails> {
	const contentType = response.headers.get("content-type") ?? "";
	if (isJsonLikeContentType(contentType)) {
		const payload = await response
			.clone()
			.json()
			.catch(() => null);
		if (payload && typeof payload === "object" && !Array.isArray(payload)) {
			return extractJsonErrorPayload(
				payload as Record<string, unknown>,
				response.status,
				{
					contentType,
				},
			);
		}
	}

	const bytes = new Uint8Array(
		await response
			.clone()
			.arrayBuffer()
			.catch(() => new ArrayBuffer(0)),
	);
	if (bytes.byteLength === 0) {
		return {
			errorCode: null,
			errorMessage: null,
			errorMetaJson: null,
		};
	}

	const decodedText = new TextDecoder().decode(bytes);
	const payloadFromText = safeJsonParse<Record<string, unknown> | null>(
		decodedText,
		null,
	);
	if (payloadFromText && typeof payloadFromText === "object") {
		return extractJsonErrorPayload(payloadFromText, response.status, {
			contentType,
		});
	}

	const payloadFromSse = extractSseJsonPayload(decodedText);
	if (payloadFromSse) {
		return extractJsonErrorPayload(payloadFromSse, response.status, {
			contentType,
		});
	}

	if (
		isLikelyBinaryContentType(contentType) &&
		!looksTextualPayload(decodedText)
	) {
		return {
			errorCode: null,
			errorMessage: `upstream_binary_error: status=${response.status}, content_type=${contentType || "-"}, bytes=${bytes.byteLength}`,
			errorMetaJson: stringifyErrorMeta({
				type: "binary_error",
				status: response.status,
				content_type: normalizeStringField(contentType),
				bytes: bytes.byteLength,
				status_text: normalizeStringField(response.statusText),
				response_headers: snapshotHeaders(response.headers),
			}),
		};
	}

	const normalizedText = normalizeMessage(decodedText);
	if (!normalizedText) {
		return {
			errorCode: null,
			errorMessage: null,
			errorMetaJson: null,
		};
	}
	if (isLikelyHtmlPayload(normalizedText)) {
		return {
			errorCode: null,
			errorMessage: summarizeHtmlErrorPayload(normalizedText, response.status),
			errorMetaJson: stringifyErrorMeta({
				type: "html_error",
				status: response.status,
				status_text: normalizeStringField(response.statusText),
				response_headers: snapshotHeaders(response.headers),
			}),
		};
	}
	const embeddedHttp = extractEmbeddedHttpStatus(normalizedText);
	return {
		errorCode: null,
		errorMessage: `upstream_text_error: status=${response.status}, detail=${normalizeSummaryDetail(normalizedText, UPSTREAM_ERROR_DETAIL_MAX_LENGTH)}`,
		errorMetaJson: stringifyErrorMeta({
			type: "text_error",
			status: response.status,
			status_text: normalizeStringField(response.statusText),
			response_headers: snapshotHeaders(response.headers),
			embedded_http_status_line: embeddedHttp.statusLine,
			embedded_http_status: embeddedHttp.statusCode,
			embedded_http_status_text: embeddedHttp.statusText,
		}),
	};
}
