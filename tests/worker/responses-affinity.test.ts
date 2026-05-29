import { describe, expect, it } from "vitest";
import {
	classifyResponsesAffinityFamily,
	shouldAllowResponsesAffinityFallback,
} from "../../apps/worker/src/services/proxy/responses-affinity";

describe("responses affinity fallback", () => {
	it("识别 OpenAI 官方与 Azure OpenAI 渠道族群", () => {
		expect(
			classifyResponsesAffinityFamily("https://api.openai.com/v1"),
		).toBe("openai");
		expect(
			classifyResponsesAffinityFamily(
				"https://example-resource.openai.azure.com/openai/v1",
			),
		).toBe("azure_openai");
		expect(
			classifyResponsesAffinityFamily(
				"https://example-resource.services.ai.azure.com/models",
			),
		).toBe("azure_openai");
	});

	it("在 OpenAI 官方与 Azure 混池时禁用 responses 续写回退", () => {
		expect(
			shouldAllowResponsesAffinityFallback([
				{ base_url: "https://api.openai.com/v1" },
				{ base_url: "https://example-resource.openai.azure.com/openai/v1" },
			]),
		).toBe(false);
	});

	it("单一上游族群时允许 responses 续写回退", () => {
		expect(
			shouldAllowResponsesAffinityFallback([
				{ base_url: "https://api.openai.com/v1" },
				{ base_url: "https://api.openai.com/v1/" },
			]),
		).toBe(true);
		expect(
			shouldAllowResponsesAffinityFallback([
				{ base_url: "https://example-resource.openai.azure.com/openai/v1" },
				{ base_url: "https://another-resource.openai.azure.com/openai/v1" },
			]),
		).toBe(true);
	});
});
