import { describe, expect, it } from "vitest";
import {
	buildVerificationModelAttemptOrder,
	collectCandidateModels,
	resolveVerificationRequestModels,
} from "../../apps/worker/src/services/site-verification-selection";

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

	it("只会返回 token 可调用的原始上游模型 ID", () => {
		expect(
			resolveVerificationRequestModels({
				model: "llama-3.1-nemotron-51b",
				tokenModelsJson: JSON.stringify([
					"meta/llama-3.1-8b-instruct",
					"nvidia/llama-3.1-nemotron-51b-instruct",
				]),
				channelModelsJson: JSON.stringify([
					{ id: "llama-3.1-nemotron-51b" },
					{ id: "meta/llama-3.1-8b-instruct" },
				]),
			}),
		).toEqual(["nvidia/llama-3.1-nemotron-51b-instruct"]);
	});

	it("找不到上游原始模型名时不会回退成 canonical 名", () => {
		expect(
			resolveVerificationRequestModels({
				model: "llama-3.1-nemotron-51b",
				tokenModelsJson: JSON.stringify(["meta/llama-3.1-8b-instruct"]),
				channelModelsJson: JSON.stringify([{ id: "llama-3.1-nemotron-51b" }]),
			}),
		).toEqual([]);
	});

	it("只有在 token 没有模型列表时才回退到 channel 里的上游模型名", () => {
		expect(
			resolveVerificationRequestModels({
				model: "meta/llama-3.1-8b",
				tokenModelsJson: null,
				channelModelsJson: JSON.stringify([
					{ id: "meta/llama-3.1-8b-instruct" },
					{ id: "openai/gpt-oss-20b" },
				]),
			}),
		).toEqual(["meta/llama-3.1-8b-instruct"]);
	});

	it("会把当前选中的模型放在回退顺序最前面", () => {
		expect(
			buildVerificationModelAttemptOrder("llama-3.1-nemotron-51b", [
				"llama-3.1-8b",
				"llama-3.1-nemotron-51b",
				"openai/gpt-oss-20b",
			]),
		).toEqual([
			"llama-3.1-nemotron-51b",
			"llama-3.1-8b",
			"openai/gpt-oss-20b",
		]);
	});

	it("可限制最多尝试的候选模型数", () => {
		expect(
			buildVerificationModelAttemptOrder(
				"llama-3.1-nemotron-51b",
				[
					"llama-3.1-8b",
					"llama-3.1-nemotron-51b",
					"openai/gpt-oss-20b",
				],
				1,
			),
		).toEqual(["llama-3.1-nemotron-51b"]);
	});
});
