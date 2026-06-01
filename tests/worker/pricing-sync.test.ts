import { describe, expect, it } from "vitest";
import {
	parsePricingPage,
	syncModelPrices,
} from "../../apps/worker/src/services/pricing/sync";

describe("pricing sync parser", () => {
	it("从结构化官方价格表解析精确价", () => {
		const prices = parsePricingPage(
			"openai",
			"https://example.test/pricing",
			`
				<table>
					<thead>
						<tr>
							<th>Model</th>
							<th>Input</th>
							<th>Cached input</th>
							<th>Output</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td>gpt-4.1-mini</td>
							<td>$0.40 / 1M tokens</td>
							<td>$0.10 / 1M tokens</td>
							<td>$1.60 / 1M tokens</td>
						</tr>
					</tbody>
				</table>
			`,
		);

		expect(prices).toHaveLength(1);
		expect(prices[0]).toMatchObject({
			provider: "openai",
			model_pattern: "gpt-4.1-mini",
			currency: "USD",
			input_price_per_1m: 0.4,
			cache_read_price_per_1m: 0.1,
			cache_write_price_per_1m: 0.4,
			output_price_per_1m: 1.6,
			sync_status: "exact",
		});
	});

	it("从官方 JSON-LD/内联数据解析精确价", () => {
		const prices = parsePricingPage(
			"anthropic",
			"https://example.test/pricing",
			`
				<script type="application/json">
					{
						"models": [
							{
								"model": "claude-sonnet-4-20250514",
								"input_price_per_1m": 3,
								"cache_read_price_per_1m": 0.3,
								"cache_write_price_per_1m": 3.75,
								"output_price_per_1m": 15,
								"currency": "USD"
							}
						]
					}
				</script>
			`,
		);

		expect(prices).toHaveLength(1);
		expect(prices[0]).toMatchObject({
			provider: "anthropic",
			model_pattern: "claude-sonnet-4-20250514",
			input_price_per_1m: 3,
			cache_read_price_per_1m: 0.3,
			cache_write_price_per_1m: 3.75,
			output_price_per_1m: 15,
			sync_status: "exact",
		});
	});

	it("从 Anthropic 展示名价格表解析 Claude 精确价", () => {
		const prices = parsePricingPage(
			"anthropic",
			"https://example.test/pricing",
			`
				<table>
					<thead>
						<tr>
							<th>Model</th>
							<th>Input</th>
							<th>Output</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td>Claude Sonnet 4.6</td>
							<td>$3 / MTok</td>
							<td>$15 / MTok</td>
						</tr>
					</tbody>
				</table>
			`,
		);

		expect(prices).toHaveLength(1);
		expect(prices[0]).toMatchObject({
			provider: "anthropic",
			model_pattern: "claude-sonnet-4-6",
			input_price_per_1m: 3,
			output_price_per_1m: 15,
			sync_status: "exact",
		});
	});

	it("从 Anthropic 展示名正文估算 Claude 价格", () => {
		const prices = parsePricingPage(
			"anthropic",
			"https://example.test/pricing",
			"Claude Sonnet 4.6 Input $3 / MTok Output $15 / MTok",
		);

		expect(prices[0]).toMatchObject({
			provider: "anthropic",
			model_pattern: "claude-sonnet-4-6",
			input_price_per_1m: 3,
			output_price_per_1m: 15,
			sync_status: "estimated",
		});
	});

	it("从模型作为列的官方价格矩阵解析精确价", () => {
		const prices = parsePricingPage(
			"deepseek",
			"https://example.test/pricing",
			`
				<table>
					<tr>
						<td colspan="2">MODEL</td>
						<td>deepseek-v4-flash</td>
						<td>deepseek-v4-pro</td>
					</tr>
					<tr>
						<td rowspan="3">PRICING</td>
						<td>1M INPUT TOKENS (CACHE HIT)</td>
						<td>$0.0028</td>
						<td>$0.003625</td>
					</tr>
					<tr>
						<td>1M INPUT TOKENS (CACHE MISS)</td>
						<td>$0.14</td>
						<td>$0.435</td>
					</tr>
					<tr>
						<td>1M OUTPUT TOKENS</td>
						<td>$0.28</td>
						<td>$0.87</td>
					</tr>
				</table>
			`,
		);

		expect(prices).toEqual([
			expect.objectContaining({
				model_pattern: "deepseek-v4-flash",
				input_price_per_1m: 0.14,
				cache_read_price_per_1m: 0.0028,
				cache_write_price_per_1m: 0.14,
				output_price_per_1m: 0.28,
				sync_status: "exact",
			}),
			expect.objectContaining({
				model_pattern: "deepseek-v4-pro",
				input_price_per_1m: 0.435,
				cache_read_price_per_1m: 0.003625,
				output_price_per_1m: 0.87,
				sync_status: "exact",
			}),
		]);
	});

	it("无法结构化解析时才退回估算价", () => {
		const prices = parsePricingPage(
			"deepseek",
			"https://example.test/pricing",
			"deepseek-chat input ¥2 output ¥8",
		);

		expect(prices[0]).toMatchObject({
			model_pattern: "deepseek-chat",
			currency: "CNY",
			input_price_per_1m: 2,
			output_price_per_1m: 8,
			sync_status: "estimated",
		});
	});

	it("估算价不会把模型版本号误当成价格", () => {
		const prices = parsePricingPage(
			"openai",
			"https://example.test/pricing",
			"gpt-4.1-mini Input $0.40 / 1M tokens Output $1.60 / 1M tokens",
		);

		expect(prices[0]).toMatchObject({
			model_pattern: "gpt-4.1-mini",
			input_price_per_1m: 0.4,
			output_price_per_1m: 1.6,
			sync_status: "estimated",
		});
	});

	it("同步成功后替换同提供方的旧同步价，避免估算残留", async () => {
		const deletedProviders: unknown[][] = [];
		const insertedModels: unknown[][] = [];
		const db = {
			prepare(sql: string) {
				return {
					bind(...params: unknown[]) {
						return {
							async run() {
								if (sql.startsWith("DELETE FROM model_prices")) {
									deletedProviders.push(params);
								}
								if (sql.startsWith("INSERT INTO model_prices")) {
									insertedModels.push(params);
								}
								return { success: true };
							},
							async all() {
								return { results: [{ name: "sync_status" }] };
							},
						};
					},
					async all() {
						return { results: [{ name: "sync_status" }] };
					},
				};
			},
		};

		await syncModelPrices(db as never, {
			sources: ["deepseek"],
			fetcher: async () =>
				new Response(
					`
						<table>
							<tr><td>MODEL</td><td>deepseek-v4-flash</td></tr>
							<tr><td>1M INPUT TOKENS (CACHE MISS)</td><td>$0.14</td></tr>
							<tr><td>1M OUTPUT TOKENS</td><td>$0.28</td></tr>
						</table>
					`,
					{ status: 200 },
				),
		});

		expect(deletedProviders).toEqual([["official_sync", "deepseek"]]);
		expect(insertedModels[0]).toContain("deepseek-v4-flash");
	});

	it("同步没有解析到价格时把该来源标记为失败", async () => {
		const db = {
			prepare() {
				return {
					bind() {
						return {
							async run() {
								return { success: true };
							},
							async all() {
								return { results: [{ name: "sync_status" }] };
							},
						};
					},
					async all() {
						return { results: [{ name: "sync_status" }] };
					},
				};
			},
		};

		const result = await syncModelPrices(db as never, {
			sources: ["anthropic"],
			fetcher: async () => new Response("<html>No prices here</html>", { status: 200 }),
		});

		expect(result.ok).toBe(false);
		expect(result.items[0]).toMatchObject({
			source: "anthropic",
			ok: false,
			count: 0,
			message: "no_prices_found",
		});
	});

	it("同步入库前按全局计价币种转换", async () => {
		const insertedModels: unknown[][] = [];
		const db = {
			prepare(sql: string) {
				return {
					bind(...params: unknown[]) {
						return {
							async run() {
								if (sql.startsWith("INSERT INTO model_prices")) {
									insertedModels.push(params);
								}
								return { success: true };
							},
							async all() {
								return { results: [{ name: "sync_status" }] };
							},
						};
					},
					async all() {
						return { results: [{ name: "sync_status" }] };
					},
				};
			},
		};

		await syncModelPrices(db as never, {
			sources: ["deepseek"],
			targetCurrency: "CNY",
			usdCnyRate: 7,
			fetcher: async () =>
				new Response(
					`
						<table>
							<tr><td>MODEL</td><td>deepseek-v4-flash</td></tr>
							<tr><td>1M INPUT TOKENS (CACHE MISS)</td><td>$0.14</td></tr>
							<tr><td>1M OUTPUT TOKENS</td><td>$0.28</td></tr>
						</table>
					`,
					{ status: 200 },
				),
		});

		expect(insertedModels[0][4]).toBe("CNY");
		expect(insertedModels[0][5]).toBeCloseTo(0.98);
		expect(insertedModels[0][8]).toBeCloseTo(1.96);
	});
});
