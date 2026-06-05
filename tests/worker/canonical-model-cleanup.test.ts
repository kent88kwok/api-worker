import { describe, expect, it } from "vitest";
import { planCanonicalModelCleanup } from "../../apps/worker/src/services/canonical-model-cleanup";

describe("canonical model cleanup planning", () => {
	it("只识别没有精确别名和导入正则、且已被其他统一模型接管的残留项", () => {
		const result = planCanonicalModelCleanup({
			registryRows: [
				{
					canonical_model: "openai/gpt-5.4",
					import_regex: "^gpt-5\\.4$",
					created_at: "2026-06-05T00:00:00.000Z",
					updated_at: "2026-06-05T00:00:00.000Z",
				},
				{
					canonical_model: "gpt-5.4",
					import_regex: null,
					created_at: "2026-06-05T00:00:00.000Z",
					updated_at: "2026-06-05T00:00:00.000Z",
				},
				{
					canonical_model: "kept/no-regex",
					import_regex: null,
					created_at: "2026-06-05T00:00:00.000Z",
					updated_at: "2026-06-05T00:00:00.000Z",
				},
			],
			aliasRows: [
				{
					alias: "openai/gpt-5.4",
					provider_hint: "",
					canonical_model: "openai/gpt-5.4",
				},
				{
					alias: "gpt-5.4",
					provider_hint: "",
					canonical_model: "openai/gpt-5.4",
				},
			],
		});

		expect(result).toEqual([
			expect.objectContaining({
				canonical_model: "gpt-5.4",
				replacement_canonical_models: ["openai/gpt-5.4"],
			}),
		]);
	});
});
