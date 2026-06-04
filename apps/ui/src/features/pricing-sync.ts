import type { SettingsForm } from "../core/types";

type PricingDisplayConfig = Pick<
	SettingsForm,
	"pricing_currency" | "pricing_usd_cny_rate"
>;

function normalizeCurrency(value: PricingDisplayConfig["pricing_currency"]) {
	return String(value ?? "USD")
		.trim()
		.toUpperCase();
}

function normalizeRate(value: PricingDisplayConfig["pricing_usd_cny_rate"]) {
	const rate = Number(value ?? "");
	return Number.isFinite(rate) && rate > 0 ? rate : null;
}

export function didPricingDisplayConfigChange(
	current: PricingDisplayConfig,
	previous: PricingDisplayConfig,
) {
	return (
		normalizeCurrency(current.pricing_currency) !==
			normalizeCurrency(previous.pricing_currency) ||
		normalizeRate(current.pricing_usd_cny_rate) !==
			normalizeRate(previous.pricing_usd_cny_rate)
	);
}
