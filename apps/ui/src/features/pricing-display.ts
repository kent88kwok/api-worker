import type {
	ModelPriceSource,
	ModelPriceSyncStatus,
	PricingSyncItem,
} from "../core/types";

type ChargeBucket = {
	currency: string | null | undefined;
	amount: number | null | undefined;
};

export const formatChargeAmount = (
	amount: number | null | undefined,
	currency: string | null | undefined,
) => {
	if (amount === null || amount === undefined || !Number.isFinite(amount)) {
		return "-";
	}
	return `${currency || "USD"} ${amount.toFixed(6)}`;
};

export const formatChargeByCurrency = (items: ChargeBucket[]) => {
	const buckets = new Map<string, number>();
	for (const item of items) {
		const amount = Number(item.amount ?? 0);
		if (!Number.isFinite(amount)) {
			continue;
		}
		const currency = String(item.currency || "USD").toUpperCase();
		buckets.set(currency, (buckets.get(currency) ?? 0) + amount);
	}
	if (buckets.size === 0) {
		return "-";
	}
	return Array.from(buckets.entries())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([currency, amount]) => formatChargeAmount(amount, currency))
		.join(" / ");
};

export const getPriceSourceLabel = (
	source: ModelPriceSource,
	syncStatus?: ModelPriceSyncStatus | null,
	sourceUrl?: string | null,
) => {
	if (source === "manual") {
		return "手动销售价";
	}
	if (source === "official_sync") {
		if (String(sourceUrl ?? "").includes("openrouter.ai")) {
			return "渠道补充价";
		}
		return syncStatus === "exact" ? "同步精确价" : "同步估算价";
	}
	return "未知来源";
};

export const getPricingSyncMessageLabel = (message: string | null | undefined) => {
	switch (message) {
		case "synced":
			return "官方同步";
		case "synced_from_openrouter":
			return "OpenRouter 补充";
		case "no_prices_found":
			return "未找到价格";
		case "unknown_source":
			return "未知来源";
		case "openrouter_fallback_empty":
			return "OpenRouter 无匹配价格";
		default:
			return message || "同步失败";
	}
};

export const formatPricingSyncItemLabel = (item: PricingSyncItem) => {
	if (!item.ok || item.count <= 0) {
		return `${item.source}：失败 ${getPricingSyncMessageLabel(item.message)}`;
	}
	return `${item.source}：成功 ${item.count} 条（精确 ${
		item.exact_count ?? 0
	} / 估算 ${item.estimated_count ?? 0}）· ${getPricingSyncMessageLabel(
		item.message,
	)}`;
};

export const getPricingSyncItemTone = (
	item: PricingSyncItem,
): "success" | "warning" => {
	if (item.ok && item.count > 0) {
		return "success";
	}
	return "warning";
};
