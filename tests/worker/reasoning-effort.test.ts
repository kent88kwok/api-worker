import { describe, expect, it } from "vitest";
import { extractReasoningEffort } from "../../apps/worker/src/utils/reasoning";

describe("reasoning effort extraction", () => {
	it("从 Anthropic output_config 读取显式思考等级", () => {
		expect(
			extractReasoningEffort({
				model: "gpt-5.5",
				thinking: { type: "adaptive" },
				output_config: { effort: "max" },
			}),
		).toBe("max");
	});
});
