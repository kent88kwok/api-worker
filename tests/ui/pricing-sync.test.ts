import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { didPricingDisplayConfigChange } from "../../apps/ui/src/features/pricing-sync";

const appSource = readFileSync("apps/ui/src/App.tsx", "utf8");

describe("pricing display config sync", () => {
	it("计价币种变化时需要刷新相关视图", () => {
		expect(
			didPricingDisplayConfigChange(
				{
					pricing_currency: "USD",
					pricing_usd_cny_rate: "7.2",
				},
				{
					pricing_currency: "CNY",
					pricing_usd_cny_rate: "7.2",
				},
			),
		).toBe(true);
	});

	it("汇率变化时需要刷新相关视图", () => {
		expect(
			didPricingDisplayConfigChange(
				{
					pricing_currency: "USD",
					pricing_usd_cny_rate: "7.35",
				},
				{
					pricing_currency: "USD",
					pricing_usd_cny_rate: "7.2",
				},
			),
		).toBe(true);
	});

	it("数值等价的汇率字符串不重复触发刷新", () => {
		expect(
			didPricingDisplayConfigChange(
				{
					pricing_currency: "usd",
					pricing_usd_cny_rate: "7.20",
				},
				{
					pricing_currency: "USD",
					pricing_usd_cny_rate: "7.2",
				},
			),
		).toBe(false);
	});

	it("数据面板和使用日志加载时会同步读取当前计价设置", () => {
		expect(appSource).toMatch(
			/if \(tabId === "dashboard"\)[\s\S]*?await Promise\.all\(\[[\s\S]*?loadSettings\(\)[\s\S]*?loadDashboard\(\)[\s\S]*?loadSites\(\)[\s\S]*?loadTokens\(\)[\s\S]*?\]\);/u,
		);
		expect(appSource).toMatch(
			/if \(tabId === "usage"\)[\s\S]*?await Promise\.all\(\[[\s\S]*?loadSettings\(\)[\s\S]*?loadUsage\(\)[\s\S]*?loadSites\(\)[\s\S]*?loadTokens\(\)[\s\S]*?loadModels\(\)[\s\S]*?\]\);/u,
		);
	});
});
