import { describe, expect, it } from "vitest";
import {
	buildRequestEntryFormatAttemptOrder,
	resolveUpstreamProviderForRequestEntryFormat,
} from "../../apps/worker/src/services/request-entry-attempts";

describe("request entry attempt order", () => {
	it("OpenAI 兼容站点自动模式只返回当前请求对应的 OpenAI 格式", () => {
		expect(
			buildRequestEntryFormatAttemptOrder({
				siteType: "openai",
				entry: {
					path: null,
					format: null,
				},
				endpointType: "chat",
			}),
		).toEqual(["openai_chat"]);

		expect(
			buildRequestEntryFormatAttemptOrder({
				siteType: "new-api",
				entry: {
					path: null,
					format: null,
				},
				endpointType: "responses",
			}),
		).toEqual(["openai_responses"]);
	});

	it("subapi 自动模式保留跨 provider 尝试但不在 OpenAI Chat/Responses 间互转", () => {
		expect(
			buildRequestEntryFormatAttemptOrder({
				siteType: "subapi",
				entry: {
					path: null,
					format: null,
				},
				endpointType: "chat",
			}),
		).toEqual([
			"openai_chat",
			"anthropic_messages",
			"gemini_generate_content",
		]);
	});

	it("请求格式会解析到对应的上游 provider", () => {
		expect(
			resolveUpstreamProviderForRequestEntryFormat(
				"anthropic_messages",
				"openai",
			),
		).toBe("anthropic");
		expect(
			resolveUpstreamProviderForRequestEntryFormat(
				"gemini_generate_content",
				"openai",
			),
		).toBe("gemini");
	});
});
