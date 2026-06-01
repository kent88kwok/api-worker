import { Hono } from "hono";
import type { AppEnv } from "../env";
import { triggerBackupAfterDataChange } from "../services/backup-auto-sync";
import { fetchUsdCnyRate } from "../services/pricing/exchange-rate";
import {
	deleteModelPrice,
	deleteBuiltinModelPrices,
	listModelPrices,
	overrideSyncedModelPriceAsManual,
	upsertModelPrice,
} from "../services/pricing/repo";
import { getPricingSettings, setPricingSettings } from "../services/settings";
import { PRICING_SOURCE_URLS, syncModelPrices } from "../services/pricing/sync";
import type { ModelPriceSource } from "../services/pricing/types";
import { jsonError } from "../utils/http";

const pricing = new Hono<AppEnv>();

function toNumber(value: unknown, fallback = 0): number {
	const parsed = Number(value ?? fallback);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSource(value: unknown): ModelPriceSource {
	return value === "official_sync" || value === "manual" ? value : "manual";
}

const priceFieldKeys = [
	"provider",
	"model_pattern",
	"model_name",
	"currency",
	"input_price_per_1m",
	"cache_read_price_per_1m",
	"cache_write_price_per_1m",
	"output_price_per_1m",
];

function hasPriceFieldPatch(body: Record<string, unknown>): boolean {
	return priceFieldKeys.some((key) => body[key] !== undefined);
}

pricing.get("/models", async (c) => {
	const prices = await listModelPrices(c.env.DB);
	return c.json({ prices });
});

pricing.post("/models", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (!body?.model_pattern) {
		return jsonError(
			c,
			400,
			"model_pattern_required",
			"model_pattern_required",
		);
	}
	const pricingSettings = await getPricingSettings(c.env.DB);
	const price = await upsertModelPrice(c.env.DB, {
		provider: String(body.provider ?? "custom").trim() || "custom",
		model_pattern: String(body.model_pattern).trim(),
		model_name: String(body.model_name ?? body.model_pattern).trim(),
		currency: pricingSettings.currency,
		input_price_per_1m: toNumber(body.input_price_per_1m),
		cache_read_price_per_1m: toNumber(body.cache_read_price_per_1m),
		cache_write_price_per_1m: toNumber(body.cache_write_price_per_1m),
		output_price_per_1m: toNumber(body.output_price_per_1m),
		source: normalizeSource(body.source),
		source_url: body.source_url ? String(body.source_url) : null,
		sync_status: null,
		enabled: body.enabled === false || body.enabled === 0 ? 0 : 1,
	});
	await triggerBackupAfterDataChange(c.env.DB);
	return c.json({ price });
});

pricing.patch("/models/:id", async (c) => {
	const id = c.req.param("id");
	const existing = (await listModelPrices(c.env.DB)).find(
		(item) => item.id === id,
	);
	if (!existing) {
		return jsonError(c, 404, "price_not_found", "price_not_found");
	}
	const body = await c.req.json().catch(() => null);
	if (!body) {
		return jsonError(c, 400, "missing_body", "missing_body");
	}
	const manualOverride =
		existing.source === "official_sync" &&
		(hasPriceFieldPatch(body) || body.source === "manual");
	const nextPrice = {
		id,
		provider: String(body.provider ?? existing.provider).trim() || "custom",
		model_pattern: String(body.model_pattern ?? existing.model_pattern).trim(),
		model_name: String(
			body.model_name ?? existing.model_name ?? existing.model_pattern,
		).trim(),
		currency:
			String(body.currency ?? existing.currency)
				.trim()
				.toUpperCase() || "USD",
		input_price_per_1m: toNumber(
			body.input_price_per_1m,
			existing.input_price_per_1m,
		),
		cache_read_price_per_1m: toNumber(
			body.cache_read_price_per_1m,
			existing.cache_read_price_per_1m,
		),
		cache_write_price_per_1m: toNumber(
			body.cache_write_price_per_1m,
			existing.cache_write_price_per_1m,
		),
		output_price_per_1m: toNumber(
			body.output_price_per_1m,
			existing.output_price_per_1m,
		),
		source: normalizeSource(body.source ?? existing.source),
		source_url:
			body.source_url === undefined
				? existing.source_url
				: body.source_url
					? String(body.source_url)
					: null,
		sync_status:
			body.sync_status === "exact" || body.sync_status === "estimated"
				? body.sync_status
				: (existing.sync_status ?? null),
		enabled:
			body.enabled === undefined
				? existing.enabled
				: body.enabled === false || body.enabled === 0
					? 0
					: 1,
	};
	const price = manualOverride
		? await overrideSyncedModelPriceAsManual(c.env.DB, id, {
				...nextPrice,
				source: "manual",
				source_url: null,
				sync_status: null,
			})
		: await upsertModelPrice(c.env.DB, nextPrice);
	await triggerBackupAfterDataChange(c.env.DB);
	return c.json({ price });
});

pricing.delete("/models/:id", async (c) => {
	await deleteModelPrice(c.env.DB, c.req.param("id"));
	await triggerBackupAfterDataChange(c.env.DB);
	return c.json({ ok: true });
});

pricing.post("/seed", async (c) => {
	await deleteBuiltinModelPrices(c.env.DB);
	await triggerBackupAfterDataChange(c.env.DB);
	return c.json({ ok: true });
});

pricing.post("/sync", async (c) => {
	const body = await c.req.json().catch(() => null);
	const sources = Array.isArray(body?.sources)
		? body.sources
				.map((item: unknown) => String(item).trim())
				.filter((item: string) => item.length > 0)
		: Object.keys(PRICING_SOURCE_URLS);
	const pricingSettings = await getPricingSettings(c.env.DB);
	let usdCnyRate = pricingSettings.usd_cny_rate;
	try {
		usdCnyRate = await fetchUsdCnyRate();
		await setPricingSettings(c.env.DB, { usd_cny_rate: usdCnyRate });
	} catch {
		usdCnyRate = pricingSettings.usd_cny_rate;
	}
	const result = await syncModelPrices(c.env.DB, {
		sources,
		targetCurrency: pricingSettings.currency,
		usdCnyRate,
	});
	await setPricingSettings(c.env.DB, { last_sync_result: result });
	await triggerBackupAfterDataChange(c.env.DB);
	return c.json(result);
});

pricing.get("/sources", (c) =>
	c.json({
		sources: Object.entries(PRICING_SOURCE_URLS).map(([id, url]) => ({
			id,
			url,
		})),
	}),
);

export default pricing;
