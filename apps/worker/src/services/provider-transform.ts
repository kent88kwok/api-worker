import {
	applyGeminiModelToPathViaWasm,
	buildUpstreamChatRequestViaWasm,
	detectDownstreamProviderViaWasm,
	detectEndpointTypeViaWasm,
	normalizeChatRequestViaWasm,
	parseDownstreamModelViaWasm,
	parseDownstreamStreamViaWasm,
} from "../wasm/core";
import type { EndpointOverrides } from "./site-metadata";

export type ProviderType = "openai" | "anthropic" | "gemini";

export type EndpointType =
	| "chat"
	| "responses"
	| "embeddings"
	| "images"
	| "passthrough";

export type NormalizedTool = {
	name: string;
	description?: string;
	parameters?: Record<string, unknown> | null;
};

export type NormalizedToolCall = {
	id: string;
	name: string;
	args: unknown;
};

export type NormalizedMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	toolCalls?: NormalizedToolCall[];
	toolCallId?: string | null;
};

export type NormalizedChatRequest = {
	model: string | null;
	stream: boolean;
	messages: NormalizedMessage[];
	tools: NormalizedTool[];
	toolChoice: unknown | null;
	temperature: number | null;
	topP: number | null;
	maxTokens: number | null;
	responseFormat: unknown | null;
	reasoning: Record<string, unknown> | null;
};

export type NormalizedEmbeddingRequest = {
	model: string | null;
	inputs: string[];
};

export type NormalizedImageRequest = {
	model: string | null;
	prompt: string;
	n: number | null;
	size: string | null;
	quality: string | null;
	style: string | null;
	responseFormat: string | null;
};

export type UpstreamRequest = {
	path: string;
	fallbackPath?: string;
	absoluteUrl?: string;
	body: Record<string, unknown> | null;
};

function normalizeOpenAiBodyForWasm(
	body: Record<string, unknown> | null,
): Record<string, unknown> | null {
	if (!body) {
		return body;
	}
	const nextBody: Record<string, unknown> = { ...body };
	if (Array.isArray(body.messages)) {
		nextBody.messages = body.messages.map((rawMessage) => {
			if (
				!rawMessage ||
				typeof rawMessage !== "object" ||
				Array.isArray(rawMessage)
			) {
				return rawMessage;
			}
			const message = rawMessage as Record<string, unknown>;
			const normalizedMessage: Record<string, unknown> = { ...message };
			if (
				normalizedMessage.tool_calls === undefined &&
				Array.isArray(normalizedMessage.toolCalls)
			) {
				normalizedMessage.tool_calls = normalizedMessage.toolCalls;
			}
			if (
				normalizedMessage.function_call === undefined &&
				normalizedMessage.functionCall !== undefined
			) {
				normalizedMessage.function_call = normalizedMessage.functionCall;
			}
			if (
				normalizedMessage.tool_call_id === undefined &&
				normalizedMessage.toolCallId !== undefined
			) {
				normalizedMessage.tool_call_id = normalizedMessage.toolCallId;
			}
			if (
				normalizedMessage.call_id === undefined &&
				normalizedMessage.callId !== undefined
			) {
				normalizedMessage.call_id = normalizedMessage.callId;
			}
			if (Array.isArray(normalizedMessage.tool_calls)) {
				normalizedMessage.tool_calls = normalizedMessage.tool_calls.map(
					(rawCall) => {
						if (
							!rawCall ||
							typeof rawCall !== "object" ||
							Array.isArray(rawCall)
						) {
							return rawCall;
						}
						const call = rawCall as Record<string, unknown>;
						const normalizedCall: Record<string, unknown> = { ...call };
						if (
							normalizedCall.call_id === undefined &&
							normalizedCall.callId !== undefined
						) {
							normalizedCall.call_id = normalizedCall.callId;
						}
						if (
							normalizedCall.function === undefined &&
							normalizedCall.functionCall !== undefined &&
							typeof normalizedCall.functionCall === "object"
						) {
							normalizedCall.function = normalizedCall.functionCall;
						}
						return normalizedCall;
					},
				);
			}
			return normalizedMessage;
		});
	}
	if (body.input !== undefined) {
		const rawInput = body.input;
		if (Array.isArray(rawInput)) {
			nextBody.input = rawInput.map((rawItem) => {
				if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
					return rawItem;
				}
				const item = rawItem as Record<string, unknown>;
				const normalizedItem: Record<string, unknown> = { ...item };
				if (
					normalizedItem.call_id === undefined &&
					normalizedItem.callId !== undefined
				) {
					normalizedItem.call_id = normalizedItem.callId;
				}
				if (
					normalizedItem.tool_call_id === undefined &&
					normalizedItem.toolCallId !== undefined
				) {
					normalizedItem.tool_call_id = normalizedItem.toolCallId;
				}
				return normalizedItem;
			});
		} else if (
			rawInput &&
			typeof rawInput === "object" &&
			!Array.isArray(rawInput)
		) {
			const item = rawInput as Record<string, unknown>;
			const normalizedItem: Record<string, unknown> = { ...item };
			if (
				normalizedItem.call_id === undefined &&
				normalizedItem.callId !== undefined
			) {
				normalizedItem.call_id = normalizedItem.callId;
			}
			if (
				normalizedItem.tool_call_id === undefined &&
				normalizedItem.toolCallId !== undefined
			) {
				normalizedItem.tool_call_id = normalizedItem.toolCallId;
			}
			nextBody.input = normalizedItem;
		}
	}
	return nextBody;
}

export function detectDownstreamProvider(path: string): ProviderType {
	const provider = detectDownstreamProviderViaWasm(path);
	if (
		provider === "openai" ||
		provider === "anthropic" ||
		provider === "gemini"
	) {
		return provider;
	}
	throw new Error(`Unexpected provider from wasm: ${provider}`);
}

export function detectEndpointType(
	provider: ProviderType,
	path: string,
): EndpointType {
	const endpoint = detectEndpointTypeViaWasm(provider, path);
	if (
		endpoint === "chat" ||
		endpoint === "responses" ||
		endpoint === "embeddings" ||
		endpoint === "images" ||
		endpoint === "passthrough"
	) {
		return endpoint;
	}
	throw new Error(`Unexpected endpoint from wasm: ${endpoint}`);
}

export function parseDownstreamModel(
	provider: ProviderType,
	path: string,
	body: Record<string, unknown> | null,
): string | null {
	return parseDownstreamModelViaWasm(provider, path, body);
}

export function parseDownstreamStream(
	provider: ProviderType,
	path: string,
	body: Record<string, unknown> | null,
): boolean {
	return parseDownstreamStreamViaWasm(provider, path, body);
}

export function normalizeChatRequest(
	provider: ProviderType,
	endpoint: EndpointType,
	body: Record<string, unknown> | null,
	model: string | null,
	isStream: boolean,
): NormalizedChatRequest | null {
	const normalizedBody =
		provider === "openai" ? normalizeOpenAiBodyForWasm(body) : body;
	return normalizeChatRequestViaWasm<NormalizedChatRequest>(
		normalizedBody,
		provider,
		endpoint,
		model,
		isStream,
	);
}

export function buildUpstreamChatRequest(
	provider: ProviderType,
	normalized: NormalizedChatRequest,
	model: string | null,
	endpoint: EndpointType,
	isStream: boolean,
	endpointOverrides: EndpointOverrides,
): UpstreamRequest | null {
	return buildUpstreamChatRequestViaWasm<UpstreamRequest>(
		normalized as unknown as Record<string, unknown>,
		provider,
		model,
		endpoint,
		isStream,
		endpointOverrides as unknown as Record<string, unknown>,
	);
}

export function applyGeminiModelToPath(
	path: string,
	model: string | null,
): string {
	return applyGeminiModelToPathViaWasm(path, model);
}
