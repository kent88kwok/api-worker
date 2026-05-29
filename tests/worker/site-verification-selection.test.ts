import { describe, expect, it } from "vitest";
import { collectCandidateModels } from "../../apps/worker/src/services/site-verification-selection";

const tokens = [{ api_key: "token-a", models_json: null }];

describe("site verification model selection", () => {
	it("使用发现模型和手动补充模型，并跳过手动排除模型", () => {
		const selection = collectCandidateModels({
			channel: {
				models_json: JSON.stringify([{ id: "legacy-only" }]),
				metadata_json: JSON.stringify({
					manual_include_models: ["manual-model"],
					manual_exclude_models: ["discovered-bad", "legacy-only"],
				}),
			},
			tokens,
			discoveredModels: ["discovered-ok", "discovered-bad"],
			mappedDefaultModel: null,
			lastVerifiedModel: null,
			random: () => 0,
		});

		expect(selection.all).toEqual(["discovered-ok", "manual-model"]);
		expect(selection.model).toBe("discovered-ok");
	});
});
