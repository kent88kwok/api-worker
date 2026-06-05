import { describe, expect, it } from "vitest";
import { planOrphanManualPrices } from "../../apps/worker/src/services/pricing/maintenance";

describe("manual pricing cleanup planning", () => {
	it("只把没有命中任何模型的手动价格当作孤儿价", () => {
		const result = planOrphanManualPrices({
			prices: [
				{
					id: "manual-hit",
					provider: "manual",
					canonical_model: "gpt-5.4",
					model_pattern: "gpt-5.4",
					model_name: "gpt-5.4",
					currency: "CNY",
					input_price_per_1m: 1,
					cache_read_price_per_1m: 0,
					cache_write_price_per_1m: 1,
					output_price_per_1m: 2,
					source: "manual",
					source_url: null,
					sync_status: null,
					enabled: 1,
					updated_at: "2026-06-05T00:00:00.000Z",
				},
				{
					id: "manual-wildcard-hit",
					provider: "manual",
					canonical_model: "claude-sonnet-4.6",
					model_pattern: "claude-*",
					model_name: "claude-*",
					currency: "CNY",
					input_price_per_1m: 1,
					cache_read_price_per_1m: 0,
					cache_write_price_per_1m: 1,
					output_price_per_1m: 2,
					source: "manual",
					source_url: null,
					sync_status: null,
					enabled: 1,
					updated_at: "2026-06-05T00:00:00.000Z",
				},
				{
					id: "manual-orphan",
					provider: "manual",
					canonical_model: "legacy-model",
					model_pattern: "legacy-model",
					model_name: "legacy-model",
					currency: "CNY",
					input_price_per_1m: 1,
					cache_read_price_per_1m: 0,
					cache_write_price_per_1m: 1,
					output_price_per_1m: 2,
					source: "manual",
					source_url: null,
					sync_status: null,
					enabled: 1,
					updated_at: "2026-06-05T00:00:00.000Z",
				},
				{
					id: "synced-ignore",
					provider: "openai",
					canonical_model: "legacy-model",
					model_pattern: "legacy-model",
					model_name: "legacy-model",
					currency: "CNY",
					input_price_per_1m: 1,
					cache_read_price_per_1m: 0,
					cache_write_price_per_1m: 1,
					output_price_per_1m: 2,
					source: "official_sync",
					source_url: "https://example.com/pricing",
					sync_status: "exact",
					enabled: 1,
					updated_at: "2026-06-05T00:00:00.000Z",
				},
			],
			knownModels: ["openai/gpt-5.4", "anthropic/claude-sonnet-4.6"],
		});

		expect(result).toEqual([
			expect.objectContaining({
				id: "manual-orphan",
				model_pattern: "legacy-model",
			}),
		]);
	});
});
