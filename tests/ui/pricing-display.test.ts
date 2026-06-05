import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
	formatChargeByCurrency,
	formatChargeAmount,
	formatPricingSyncItemLabel,
	getCurrencyDisplayLabel,
	getPriceSourceLabel,
	getPricingSyncItemTone,
} from "../../apps/ui/src/features/pricing-display";

const pricingViewSource = readFileSync("apps/ui/src/features/PricingView.tsx", "utf8");

describe("pricing display helpers", () => {
	it("按同步可信度展示同步价标签", () => {
		expect(getPriceSourceLabel("manual")).toBe("手动销售价");
		expect(getPriceSourceLabel("official_sync")).toBe("同步估算价");
		expect(getPriceSourceLabel("official_sync", "estimated")).toBe(
			"同步估算价",
		);
		expect(getPriceSourceLabel("official_sync", "exact")).toBe("同步精确价");
	});

	it("单条金额保留自己的单位", () => {
		expect(formatChargeAmount(0.42, "CNY")).toBe("¥0.420000");
		expect(formatChargeAmount(7.2, "CNY", "USD", 7.2)).toBe("$1.000000");
		expect(
			formatChargeByCurrency(
				[
					{ currency: "USD", amount: 1 },
					{ currency: "CNY", amount: 7.2 },
				],
				"USD",
				7.2,
			),
		).toBe("$2.000000");
		expect(getCurrencyDisplayLabel("CNY")).toBe("人民币 (¥)");
	});

	it("同步结果逐来源展示成功数量和失败原因", () => {
		expect(
			formatPricingSyncItemLabel({
				source: "openai",
				ok: true,
				count: 12,
				exact_count: 10,
				estimated_count: 2,
				message: "synced",
			}),
		).toBe("openai：成功 12 条（精确 10 / 估算 2）· 官方同步");
		expect(
			formatPricingSyncItemLabel({
				source: "anthropic",
				ok: false,
				count: 0,
				exact_count: 0,
				estimated_count: 0,
				message: "no_prices_found",
			}),
		).toBe("anthropic：失败 · 未找到价格");
		expect(
			getPricingSyncItemTone({
				source: "anthropic",
				ok: false,
				count: 0,
				exact_count: 0,
				estimated_count: 0,
				message: "no_prices_found",
			}),
		).toBe("warning");
	});

	it("提供清理手动价格入口", () => {
		expect(pricingViewSource).toContain("清理手动价格");
		expect(pricingViewSource).toContain("onCleanupManualPrices");
	});
});
