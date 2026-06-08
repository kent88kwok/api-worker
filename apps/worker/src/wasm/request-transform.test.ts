import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { safeJsonParse } from "../utils/json";
import * as wasmBindings from "./generated/worker_wasm_core.js";

await wasmBindings.default({
	module_or_path: await readFile(
		new URL("./generated/worker_wasm_core_bg.wasm", import.meta.url),
	),
});

function toJson(value: unknown): string {
	return JSON.stringify(value);
}

function normalizeChatRequest(
	body: Record<string, unknown>,
	provider: string,
	endpoint: string,
	model: string,
) {
	return safeJsonParse<Record<string, unknown> | null>(
		wasmBindings.normalize_chat_request(
			toJson(body),
			provider,
			endpoint,
			model,
			false,
		),
		null,
	);
}

function buildChatRequest(
	normalized: Record<string, unknown> | null,
	provider: string,
	endpoint: string,
	model: string,
) {
	return safeJsonParse<{
		body?: Record<string, unknown>;
	} | null>(
		wasmBindings.build_upstream_chat_request(
			toJson(normalized),
			provider,
			model,
			endpoint,
			false,
			toJson({}),
		),
		null,
	);
}

describe("wasm request transform", () => {
	it("OpenAI Responses 请求缺少 input 但带 messages 时会反建 input", () => {
		const normalized = normalizeChatRequest(
			{
				model: "gpt-5.5",
				messages: [{ role: "user", content: "ping" }],
				stream: false,
			},
			"openai",
			"responses",
			"gpt-5.5",
		);

		expect(
			(normalized?.rawResponsesBody as Record<string, unknown> | undefined)
				?.input,
		).toEqual([{ role: "user", content: "ping" }]);
		expect(
			(normalized?.rawResponsesBody as Record<string, unknown> | undefined)
				?.messages,
		).toBeUndefined();

		const request = buildChatRequest(
			normalized,
			"openai",
			"responses",
			"gpt-5.5",
		);

		expect(request?.body?.input).toEqual([{ role: "user", content: "ping" }]);
	});

	it("Anthropic thinking budget 转 OpenAI chat 时映射为 reasoning_effort", () => {
		const normalized = normalizeChatRequest(
			{
				model: "claude-sonnet-4-6",
				max_tokens: 16000,
				thinking: { type: "enabled", budget_tokens: 8192 },
				messages: [{ role: "user", content: "ping" }],
			},
			"anthropic",
			"chat",
			"claude-sonnet-4-6",
		);

		const request = buildChatRequest(normalized, "openai", "chat", "gpt-5.5");

		expect(request?.body?.reasoning_effort).toBe("high");
	});

	it("Anthropic adaptive max 转 OpenAI chat 时降级为 xhigh", () => {
		const normalized = normalizeChatRequest(
			{
				model: "claude-opus-4-8",
				max_tokens: 16000,
				thinking: { type: "adaptive" },
				output_config: { effort: "max" },
				messages: [{ role: "user", content: "ping" }],
			},
			"anthropic",
			"chat",
			"claude-opus-4-8",
		);

		const request = buildChatRequest(normalized, "openai", "chat", "gpt-5.5");

		expect(request?.body?.reasoning_effort).toBe("xhigh");
	});

	it("Anthropic 同 provider 重建时保留 adaptive thinking 和 output_config", () => {
		const normalized = normalizeChatRequest(
			{
				model: "claude-opus-4-8",
				max_tokens: 16000,
				thinking: { type: "adaptive" },
				output_config: { effort: "max" },
				messages: [{ role: "user", content: "ping" }],
			},
			"anthropic",
			"chat",
			"claude-opus-4-8",
		);

		const request = buildChatRequest(
			normalized,
			"anthropic",
			"chat",
			"claude-opus-4-8",
		);

		expect(request?.body?.thinking).toEqual({
			type: "adaptive",
		});
		expect(request?.body?.output_config).toEqual({
			effort: "max",
		});
	});

	it("OpenAI reasoning effort 转 Anthropic 时映射为 adaptive thinking 和 output_config", () => {
		const normalized = normalizeChatRequest(
			{
				model: "gpt-5.5",
				max_tokens: 16000,
				reasoning_effort: "high",
				messages: [{ role: "user", content: "ping" }],
			},
			"openai",
			"chat",
			"gpt-5.5",
		);

		const request = buildChatRequest(
			normalized,
			"anthropic",
			"chat",
			"claude-sonnet-4-6",
		);

		expect(request?.body?.thinking).toEqual({
			type: "adaptive",
		});
		expect(request?.body?.output_config).toEqual({
			effort: "high",
		});
	});

	it("OpenAI xhigh 转 Anthropic 时保留为 output_config effort xhigh", () => {
		const normalized = normalizeChatRequest(
			{
				model: "gpt-5.5",
				max_tokens: 16000,
				reasoning: { effort: "xhigh" },
				messages: [{ role: "user", content: "ping" }],
			},
			"openai",
			"chat",
			"gpt-5.5",
		);

		const request = buildChatRequest(
			normalized,
			"anthropic",
			"chat",
			"claude-opus-4-8",
		);

		expect(request?.body?.thinking).toEqual({
			type: "adaptive",
		});
		expect(request?.body?.output_config).toEqual({
			effort: "xhigh",
		});
	});

	it("Gemini thinkingLevel 转 OpenAI chat 时映射为 reasoning_effort", () => {
		const normalized = normalizeChatRequest(
			{
				contents: [{ role: "user", parts: [{ text: "ping" }] }],
				generationConfig: {
					thinkingConfig: { thinkingLevel: "high" },
				},
			},
			"gemini",
			"chat",
			"gemini-3-pro",
		);

		const request = buildChatRequest(normalized, "openai", "chat", "gpt-5.5");

		expect(request?.body?.reasoning_effort).toBe("high");
	});

	it("OpenAI reasoning effort 转 Gemini 3 Pro 时映射为 thinkingLevel", () => {
		const normalized = normalizeChatRequest(
			{
				model: "gpt-5.5",
				reasoning: { effort: "medium" },
				messages: [{ role: "user", content: "ping" }],
			},
			"openai",
			"chat",
			"gpt-5.5",
		);

		const request = buildChatRequest(
			normalized,
			"gemini",
			"chat",
			"gemini-3-pro",
		);

		expect(
			(
				(request?.body?.generationConfig as Record<string, unknown>)
					?.thinkingConfig as Record<string, unknown>
			)?.thinkingLevel,
		).toBe("medium");
	});

	it("Gemini 同 provider 重建时保留原始 thinkingConfig", () => {
		const thinkingConfig = {
			thinkingBudget: 2048,
			includeThoughts: true,
		};
		const normalized = normalizeChatRequest(
			{
				contents: [{ role: "user", parts: [{ text: "ping" }] }],
				generationConfig: {
					maxOutputTokens: 4096,
					thinkingConfig,
				},
			},
			"gemini",
			"chat",
			"gemini-2.5-pro",
		);

		const request = buildChatRequest(
			normalized,
			"gemini",
			"chat",
			"gemini-2.5-pro",
		);

		expect(
			(request?.body?.generationConfig as Record<string, unknown>)
				?.thinkingConfig,
		).toEqual(thinkingConfig);
	});
});
