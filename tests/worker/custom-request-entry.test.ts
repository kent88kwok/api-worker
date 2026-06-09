import { describe, expect, it } from "vitest";
import { applyCustomRequestEntry } from "../../apps/worker/src/services/proxy/custom-request-entry";

describe("custom request entry", () => {
	it("缺少 downstreamProvider 时会直接报错，避免隐式回退到 OpenAI", () => {
		expect(() =>
			// @ts-expect-error 故意覆盖缺少 downstreamProvider 的非法调用
			applyCustomRequestEntry({
				siteType: "openai",
				entry: {
					path: "/codex",
					format: "openai_responses",
				},
				endpointType: "responses",
			}),
		).toThrowError("downstreamProvider is required");
	});

	it("responses 自定义入口会匹配 responses 请求", () => {
		const entry = applyCustomRequestEntry({
			siteType: "openai",
			entry: {
				path: "/codex",
				format: "openai_responses",
			},
			downstreamProvider: "openai",
			endpointType: "responses",
		});

		expect(entry).toEqual({
			path: "/codex",
			upstreamProvider: "openai",
			requestEntryFormatToPersist: "openai_responses",
		});
	});

	it("自动入口会按当前 responses 请求解析并持久化 openai_responses", () => {
		const entry = applyCustomRequestEntry({
			siteType: "openai",
			entry: {
				path: "/codex",
				format: null,
			},
			downstreamProvider: "openai",
			endpointType: "responses",
		});

		expect(entry).toEqual({
			path: "/codex",
			upstreamProvider: "openai",
			requestEntryFormatToPersist: "openai_responses",
		});
	});

	it("responses 自定义入口不会接收 chat 请求", () => {
		const entry = applyCustomRequestEntry({
			siteType: "openai",
			entry: {
				path: "/codex",
				format: "openai_responses",
			},
			downstreamProvider: "openai",
			endpointType: "chat",
		});

		expect(entry).toBeNull();
	});

	it("显式 formatOverride 可在内部构造 OpenAI Responses 入口", () => {
		const entry = applyCustomRequestEntry({
			siteType: "openai",
			entry: {
				path: "/codex",
				format: null,
			},
			downstreamProvider: "openai",
			endpointType: "chat",
			formatOverride: "openai_responses",
		});

		expect(entry).toEqual({
			path: "/codex",
			upstreamProvider: "openai",
			requestEntryFormatToPersist: "openai_responses",
		});
	});

	it("OpenAI 自动格式默认会先按 chat 入口处理 chat 请求", () => {
		const entry = applyCustomRequestEntry({
			siteType: "openai",
			entry: {
				path: "/codex",
				format: null,
			},
			downstreamProvider: "openai",
			endpointType: "chat",
		});

		expect(entry).toEqual({
			path: "/codex",
			upstreamProvider: "openai",
			requestEntryFormatToPersist: "openai_chat",
		});
	});

	it("完整 URL 入口会作为绝对地址", () => {
		const entry = applyCustomRequestEntry({
			siteType: "openai",
			entry: {
				path: "https://example.com/codex",
				format: "openai_responses",
			},
			downstreamProvider: "openai",
			endpointType: "responses",
		});

		expect(entry).toEqual({
			absoluteUrl: "https://example.com/codex",
			upstreamProvider: "openai",
			requestEntryFormatToPersist: "openai_responses",
		});
	});

	it("anthropic 自定义入口只匹配 Anthropic chat 请求", () => {
		const entry = applyCustomRequestEntry({
			siteType: "anthropic",
			entry: {
				path: "/v1/messages",
				format: "anthropic_messages",
			},
			downstreamProvider: "anthropic",
			endpointType: "chat",
		});

		expect(entry).toEqual({
			path: "/v1/messages",
			upstreamProvider: "anthropic",
			requestEntryFormatToPersist: "anthropic_messages",
		});
	});

	it("anthropic 自定义入口不会接收 OpenAI chat 请求", () => {
		const entry = applyCustomRequestEntry({
			siteType: "anthropic",
			entry: {
				path: "/v1/messages",
				format: "anthropic_messages",
			},
			downstreamProvider: "openai",
			endpointType: "chat",
		});

		expect(entry).toBeNull();
	});

	it("gemini 自定义入口只匹配 Gemini chat 请求", () => {
		const entry = applyCustomRequestEntry({
			siteType: "gemini",
			entry: {
				path: "/v1beta/models/{model}:generateContent",
				format: "gemini_generate_content",
			},
			downstreamProvider: "gemini",
			endpointType: "chat",
		});

		expect(entry).toEqual({
			path: "/v1beta/models/{model}:generateContent",
			upstreamProvider: "gemini",
			requestEntryFormatToPersist: "gemini_generate_content",
		});
	});

	it("仅配置 OpenAI Responses 请求格式时会落到默认端点", () => {
		expect(
			applyCustomRequestEntry({
				siteType: "openai",
				entry: {
					path: null,
					format: "openai_responses",
				},
				downstreamProvider: "openai",
				endpointType: "responses",
			}),
		).toEqual({
			path: "/v1/responses",
			upstreamProvider: "openai",
			requestEntryFormatToPersist: "openai_responses",
		});
	});
});
