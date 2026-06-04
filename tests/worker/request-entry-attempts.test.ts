import { describe, expect, it } from "vitest";
import {
	buildRequestEntryFormatAttemptOrder,
	resolveUpstreamProviderForRequestEntryFormat,
} from "../../apps/worker/src/services/request-entry-attempts";

describe("request entry attempt order", () => {
	it("subapi 自动模式按站点能力返回全部兼容请求格式", () => {
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
			"openai_responses",
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
