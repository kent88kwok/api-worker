import type { D1Database } from "@cloudflare/workers-types";
import { deriveCanonicalModel } from "../model-normalization";
import { nowIso } from "../../utils/time";
import { convertPriceFieldsCurrency } from "./exchange-rate";
import { deleteSyncedModelPricesByProvider, upsertModelPrice } from "./repo";
import type { ModelPriceRecord, PricingCurrency } from "./types";

export const PRICING_SOURCE_URLS: Record<string, string> = {
	openai: "https://developers.openai.com/api/docs/pricing",
	anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
	gemini: "https://ai.google.dev/gemini-api/docs/pricing",
	deepseek: "https://api-docs.deepseek.com/quick_start/pricing",
	qwen: "https://help.aliyun.com/zh/model-studio/billing-for-model-studio",
	moonshot: "https://platform.moonshot.cn/",
	zhipu: "https://open.bigmodel.cn/pricing",
	openrouter: "https://openrouter.ai/api/v1/models",
};

const OPENROUTER_FALLBACKS: Record<
	string,
	{ provider: string; prefixes: string[]; stripPrefix: boolean }
> = {
	zhipu: { provider: "zhipu", prefixes: ["z-ai/"], stripPrefix: true },
};

export type PricingSyncItem = {
	source: string;
	ok: boolean;
	count: number;
	exact_count: number;
	estimated_count: number;
	message: string;
};

export type PricingSyncResult = {
	ok: boolean;
	runs_at: string;
	currency: PricingCurrency;
	usd_cny_rate: number;
	items: PricingSyncItem[];
};

function textContent(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

function decodeHtml(value: string): string {
	return value
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

function inferCurrency(text: string): string {
	return /¥|￥|CNY|人民币|元/.test(text) ? "CNY" : "USD";
}

function inferModelCandidates(text: string): string[] {
	const matches = text.match(
		/\b(?:gpt-[\w.-]+|claude-[\w.-]+|gemini-[\w.-]+|deepseek-[\w.-]+|qwen[\w.-]*|moonshot-[\w.-]+|kimi-[\w.-]+|glm-[\w.-]+)\b/gi,
	);
	const anthropicMatches = Array.from(
		text.matchAll(/\bClaude\s+(Sonnet|Opus|Haiku)\s+(\d+(?:\.\d+)*)\b/gi),
	)
		.map((match) => normalizeAnthropicDisplayName(match[0] ?? ""))
		.filter((model): model is string => Boolean(model));
	return Array.from(
		new Set([
			...(matches ?? []).map((item) => item.toLowerCase()),
			...anthropicMatches,
		]),
	);
}

function inferProvider(source: string, model: string): string {
	if (source === "openrouter") {
		return "openrouter";
	}
	if (source !== "anthropic") {
		return source;
	}
	if (model.startsWith("claude-")) {
		return "anthropic";
	}
	return source;
}

function extractNearbyPrices(text: string, model: string): number[] {
	const normalizedText = text.toLowerCase();
	let index = normalizedText.indexOf(model.toLowerCase());
	let matchLength = model.length;
	if (index < 0 && model.startsWith("claude-")) {
		const displayName = anthropicModelIdToDisplayName(model);
		if (displayName) {
			index = normalizedText.indexOf(displayName.toLowerCase());
			matchLength = displayName.length;
		}
	}
	if (index < 0) {
		return [];
	}
	const nearby = text.slice(index + matchLength, index + matchLength + 600);
	const pricedMatches = nearby.match(/[$¥￥]\s*\d+(?:\.\d+)?/g) ?? [];
	const matches =
		pricedMatches.length > 0
			? pricedMatches
			: (nearby.match(/(?:input|输入|output|输出)[^\d]{0,30}\d+(?:\.\d+)?/gi) ??
				[]);
	return matches
		.map((item) => parseMoney(item))
		.filter((value): value is number => value !== null)
		.filter((value) => Number.isFinite(value) && value >= 0 && value < 100000);
}

type ParsedPrice = Omit<ModelPriceRecord, "id" | "updated_at">;

type PriceKey =
	| "input_price_per_1m"
	| "cache_read_price_per_1m"
	| "cache_write_price_per_1m"
	| "output_price_per_1m";

function normalizeModelName(value: string): string {
	return decodeHtml(value)
		.replace(/\s*\([^)]*\)\s*/g, " ")
		.replace(/\s+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
}

function normalizeAnthropicDisplayName(value: string): string | null {
	const match = decodeHtml(value).match(
		/\bClaude\s+(Sonnet|Opus|Haiku)\s+(\d+(?:\.\d+)*)\b/i,
	);
	if (!match?.[1] || !match[2]) {
		return null;
	}
	return `claude-${match[1].toLowerCase()}-${match[2].replace(/\./g, "-")}`;
}

function anthropicModelIdToDisplayName(model: string): string | null {
	const match = model.match(/^claude-(sonnet|opus|haiku)-(\d+(?:-\d+)*)$/i);
	if (!match?.[1] || !match[2]) {
		return null;
	}
	const family = match[1].slice(0, 1).toUpperCase() + match[1].slice(1);
	return `Claude ${family} ${match[2].replace(/-/g, ".")}`;
}

function normalizeMoonshotDisplayName(value: string): string | null {
	const decoded = decodeHtml(value);
	const kModel = decoded.match(/\bK2(?:\.\d+)?\b/i)?.[0];
	if (kModel) {
		return `kimi-${kModel.toLowerCase().replace(/\./g, ".")}`;
	}
	if (/Moonshot\s+V1/i.test(decoded)) {
		return "moonshot-v1";
	}
	return null;
}

function extractModelName(value: string): string | null {
	const decoded = decodeHtml(value);
	const anthropicDisplayName = normalizeAnthropicDisplayName(decoded);
	if (anthropicDisplayName) {
		return anthropicDisplayName;
	}
	const moonshotDisplayName = normalizeMoonshotDisplayName(decoded);
	if (moonshotDisplayName) {
		return moonshotDisplayName;
	}
	const match = decoded.match(
		/\b(?:gpt-[\w.-]+|claude-[\w.-]+|gemini-[\w.-]+|deepseek-[\w.-]+|qwen[\w.-]*|moonshot-[\w.-]+|kimi-[\w.-]+|glm-[\w.-]+)\b/i,
	);
	return match ? normalizeModelName(match[0]) : null;
}

function parseMoney(value: unknown): number | null {
	const text = String(value ?? "")
		.replace(/,/g, "")
		.trim();
	const match = text.match(/-?\d+(?:\.\d+)?/);
	if (!match) {
		return null;
	}
	const parsed = Number(match[0]);
	return Number.isFinite(parsed) && parsed >= 0 && parsed < 100000
		? parsed
		: null;
}

function parseTableRows(table: string): string[][] {
	const rowMatches = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
	return rowMatches
		.map((row) =>
			Array.from(row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)).map(
				(match) => decodeHtml(textContent(match[1] ?? "")),
			),
		)
		.filter((cells) => cells.length >= 2);
}

function priceFromValues(input: {
	source: string;
	sourceUrl: string;
	model: string;
	currency: string;
	inputPrice: number;
	outputPrice: number;
	cacheReadPrice?: number | null;
	cacheWritePrice?: number | null;
	syncStatus: "exact" | "estimated";
}): ParsedPrice {
	return {
		provider: inferProvider(input.source, input.model),
		canonical_model: deriveCanonicalModel(input.model),
		model_pattern: input.model,
		model_name: input.model,
		currency: input.currency,
		input_price_per_1m: input.inputPrice,
		cache_read_price_per_1m:
			input.cacheReadPrice ?? (input.inputPrice > 0 ? input.inputPrice / 4 : 0),
		cache_write_price_per_1m: input.cacheWritePrice ?? input.inputPrice,
		output_price_per_1m: input.outputPrice,
		source: "official_sync",
		source_url: input.sourceUrl,
		sync_status: input.syncStatus,
		enabled: 1,
	};
}

function parseMatrixPricingTables(
	source: string,
	sourceUrl: string,
	html: string,
): ParsedPrice[] {
	const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
	const prices: ParsedPrice[] = [];
	for (const table of tables) {
		const rows = parseTableRows(table);
		const modelRow = rows.find((cells) => {
			const modelCount = cells.filter((cell) => extractModelName(cell)).length;
			return modelCount >= 2 && cells.some((cell) => /model|模型/i.test(cell));
		});
		if (!modelRow) {
			continue;
		}
		const models = modelRow
			.map((cell) => extractModelName(cell))
			.filter((model): model is string => Boolean(model));
		const byModel = new Map<
			string,
			Partial<Record<PriceKey, number>> & { currency: string }
		>();
		for (const model of models) {
			byModel.set(model, { currency: inferCurrency(table) });
		}
		for (const cells of rows) {
			if (cells === modelRow || cells.length <= models.length) {
				continue;
			}
			const metric = cells.slice(0, cells.length - models.length).join(" ");
			const priceCells = cells.slice(-models.length);
			let key: PriceKey | null = null;
			if (
				/cache\s*hit|cached\s*input|缓存命中|缓存读取|cache\s*read/i.test(
					metric,
				)
			) {
				key = "cache_read_price_per_1m";
			} else if (
				/cache\s*write|cache\s*creation|缓存写入|缓存创建/i.test(metric)
			) {
				key = "cache_write_price_per_1m";
			} else if (/output|输出|completion/i.test(metric)) {
				key = "output_price_per_1m";
			} else if (/input|输入|prompt/i.test(metric)) {
				key = "input_price_per_1m";
			}
			if (!key) {
				continue;
			}
			for (let index = 0; index < models.length; index += 1) {
				const value = parseMoney(priceCells[index]);
				if (value === null) {
					continue;
				}
				const model = models[index];
				const record = byModel.get(model);
				if (record) {
					record[key] = value;
				}
			}
		}
		for (const [model, values] of byModel.entries()) {
			if (
				values.input_price_per_1m === undefined ||
				values.output_price_per_1m === undefined
			) {
				continue;
			}
			prices.push(
				priceFromValues({
					source,
					sourceUrl,
					model,
					currency: values.currency,
					inputPrice: values.input_price_per_1m,
					outputPrice: values.output_price_per_1m,
					cacheReadPrice: values.cache_read_price_per_1m,
					cacheWritePrice: values.cache_write_price_per_1m,
					syncStatus: "exact",
				}),
			);
		}
	}
	return dedupePrices(prices);
}

function parseHtmlTables(
	source: string,
	sourceUrl: string,
	html: string,
): ParsedPrice[] {
	const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
	const prices: ParsedPrice[] = [];
	for (const table of tables) {
		const rows = parseTableRows(table);
		let headers: string[] = [];
		for (const cells of rows) {
			if (headers.length === 0) {
				const looksLikeHeader = cells.some((cell) =>
					/model|模型|input|输入|output|输出|cached|cache|缓存|单价/i.test(
						cell,
					),
				);
				if (looksLikeHeader) {
					headers = cells;
					continue;
				}
			}
			const model = extractModelName(cells.join(" "));
			if (!model || headers.length === 0) {
				continue;
			}
			const values = new Map<PriceKey, number>();
			for (let index = 0; index < cells.length; index += 1) {
				const header = headers[index] ?? "";
				const cell = cells[index] ?? "";
				const parsed = parseMoney(cell);
				if (parsed === null) {
					continue;
				}
				if (/cache|cached|缓存/i.test(header)) {
					values.set("cache_read_price_per_1m", parsed);
					continue;
				}
				if (/output|输出/i.test(header)) {
					values.set("output_price_per_1m", parsed);
					continue;
				}
				if (
					/input|输入/i.test(header) &&
					!/token\s*数|tokens?\s*数/i.test(header)
				) {
					values.set("input_price_per_1m", parsed);
				}
			}
			const inputPrice = values.get("input_price_per_1m");
			const outputPrice = values.get("output_price_per_1m");
			if (inputPrice === undefined || outputPrice === undefined) {
				continue;
			}
			prices.push(
				priceFromValues({
					source,
					sourceUrl,
					model,
					currency: inferCurrency(`${table} ${cells.join(" ")}`),
					inputPrice,
					outputPrice,
					cacheReadPrice: values.get("cache_read_price_per_1m"),
					cacheWritePrice: values.get("cache_write_price_per_1m"),
					syncStatus: "exact",
				}),
			);
		}
	}
	return dedupePrices(prices);
}

function splitBlocksByMarker(html: string, marker: string): string[] {
	const blocks: string[] = [];
	const matches = Array.from(
		html.matchAll(/<[^>]+class=["']([^"']+)["'][^>]*>/gi),
	).filter((match) =>
		String(match[1] ?? "")
			.split(/\s+/)
			.includes(marker),
	);
	for (let index = 0; index < matches.length; index += 1) {
		const start = matches[index].index ?? 0;
		const end =
			index + 1 < matches.length
				? (matches[index + 1].index ?? html.length)
				: html.length;
		blocks.push(html.slice(start, end));
	}
	return blocks;
}

function parseMoonshotHomeCards(
	sourceUrl: string,
	html: string,
): ParsedPrice[] {
	const prices: ParsedPrice[] = [];
	for (const card of splitBlocksByMarker(html, "home-card")) {
		const title = card.match(
			/<h3[^>]*class="[^"]*home-card-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i,
		)?.[1];
		const model = normalizeMoonshotDisplayName(title ?? "");
		if (!model) {
			continue;
		}
		const pricingHtml =
			card.match(
				/<div[^>]*class="[^"]*home-card-pricing[^"]*"[^>]*>([\s\S]*?)(?:<\/a>|<section|<footer)/i,
			)?.[1] ?? card;
		const rowMatches = Array.from(
			pricingHtml.matchAll(
				/<span[^>]*>([\s\S]*?)<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/gi,
			),
		);
		const values = new Map<PriceKey, number>();
		for (const row of rowMatches) {
			const label = decodeHtml(textContent(row[1] ?? ""));
			const parsed = parseMoney(row[2] ?? "");
			if (parsed === null) {
				continue;
			}
			if (/缓存|cache/i.test(label)) {
				values.set("cache_read_price_per_1m", parsed);
			} else if (/输出|output|completion/i.test(label)) {
				values.set("output_price_per_1m", parsed);
			} else if (/输入|input|prompt/i.test(label)) {
				values.set("input_price_per_1m", parsed);
			}
		}
		const inputPrice = values.get("input_price_per_1m");
		const outputPrice = values.get("output_price_per_1m");
		if (inputPrice === undefined || outputPrice === undefined) {
			continue;
		}
		prices.push(
			priceFromValues({
				source: "moonshot",
				sourceUrl,
				model,
				currency: "CNY",
				inputPrice,
				outputPrice,
				cacheReadPrice: values.get("cache_read_price_per_1m"),
				cacheWritePrice: inputPrice,
				syncStatus: "exact",
			}),
		);
	}
	return dedupePrices(prices);
}

function mapOpenRouterFallbackPrice(
	price: ParsedPrice,
	config: { provider: string; prefixes: string[]; stripPrefix: boolean },
	sourceUrl: string,
): ParsedPrice | null {
	const matchedPrefix = config.prefixes.find((prefix) =>
		price.model_pattern.startsWith(prefix),
	);
	if (!matchedPrefix) {
		return null;
	}
	const model = config.stripPrefix
		? price.model_pattern.slice(matchedPrefix.length)
		: price.model_pattern;
	if (!model) {
		return null;
	}
	return {
		...price,
		provider: config.provider,
		model_pattern: model,
		model_name: model,
		source_url: sourceUrl,
	};
}

function findModelInObject(value: unknown): string | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const object = value as Record<string, unknown>;
	for (const key of ["model", "model_id", "modelId", "id", "name"]) {
		const model = extractModelName(String(object[key] ?? ""));
		if (model) {
			return model;
		}
	}
	return null;
}

function findNumberByKeys(
	value: unknown,
	keyPatterns: RegExp[],
	blockedPatterns: RegExp[] = [],
): number | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const object = value as Record<string, unknown>;
	for (const [key, item] of Object.entries(object)) {
		if (blockedPatterns.some((pattern) => pattern.test(key))) {
			continue;
		}
		if (!keyPatterns.some((pattern) => pattern.test(key))) {
			continue;
		}
		const parsed = parseMoney(item);
		if (parsed !== null) {
			return parsed;
		}
	}
	return null;
}

function walkObjects(
	value: unknown,
	visitor: (object: Record<string, unknown>) => void,
) {
	if (Array.isArray(value)) {
		for (const item of value) {
			walkObjects(item, visitor);
		}
		return;
	}
	if (!value || typeof value !== "object") {
		return;
	}
	const object = value as Record<string, unknown>;
	visitor(object);
	for (const item of Object.values(object)) {
		walkObjects(item, visitor);
	}
}

function parseJsonPricing(
	source: string,
	sourceUrl: string,
	html: string,
): ParsedPrice[] {
	const scriptBodies = Array.from(
		html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi),
	).map((match) => decodeHtml(match[1] ?? ""));
	const prices: ParsedPrice[] = [];
	for (const body of scriptBodies) {
		const trimmed = body.trim();
		if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		walkObjects(parsed, (object) => {
			const model = findModelInObject(object);
			if (!model) {
				return;
			}
			const inputPrice = findNumberByKeys(
				object,
				[/input/i, /prompt/i],
				[/cache/i, /cached/i],
			);
			const outputPrice = findNumberByKeys(object, [/output/i, /completion/i]);
			if (inputPrice === null || outputPrice === null) {
				return;
			}
			prices.push(
				priceFromValues({
					source,
					sourceUrl,
					model,
					currency: String(
						object.currency ?? inferCurrency(body),
					).toUpperCase(),
					inputPrice,
					outputPrice,
					cacheReadPrice: findNumberByKeys(object, [
						/cache.*read/i,
						/cached.*input/i,
					]),
					cacheWritePrice: findNumberByKeys(object, [
						/cache.*write/i,
						/cache.*creation/i,
					]),
					syncStatus: "exact",
				}),
			);
		});
	}
	return dedupePrices(prices);
}

function parseOpenRouterPricing(
	sourceUrl: string,
	body: string,
): ParsedPrice[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return [];
	}
	const data = Array.isArray((parsed as { data?: unknown }).data)
		? (parsed as { data: unknown[] }).data
		: [];
	const prices: ParsedPrice[] = [];
	for (const item of data) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const model = String((item as Record<string, unknown>).id ?? "").trim();
		const pricing = (item as Record<string, unknown>).pricing;
		if (!model || !pricing || typeof pricing !== "object") {
			continue;
		}
		const pricingRecord = pricing as Record<string, unknown>;
		const inputPrice = pricePerTokenToPricePer1m(pricingRecord.prompt);
		const outputPrice = pricePerTokenToPricePer1m(pricingRecord.completion);
		if (
			inputPrice === null ||
			outputPrice === null ||
			(inputPrice <= 0 && outputPrice <= 0)
		) {
			continue;
		}
		const cacheReadPrice = pricePerTokenToPricePer1m(
			pricingRecord.input_cache_read,
		);
		const cacheWritePrice = pricePerTokenToPricePer1m(
			pricingRecord.input_cache_write,
		);
		prices.push(
			priceFromValues({
				source: "openrouter",
				sourceUrl,
				model: normalizeOpenRouterModelName(model),
				currency: "USD",
				inputPrice,
				outputPrice,
				cacheReadPrice,
				cacheWritePrice,
				syncStatus: "exact",
			}),
		);
	}
	return dedupePrices(prices);
}

function pricePerTokenToPricePer1m(value: unknown): number | null {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return null;
	}
	return parsed * 1_000_000;
}

function normalizeOpenRouterModelName(value: string): string {
	return decodeHtml(value).trim().toLowerCase();
}

function parseEstimatedPricing(
	source: string,
	sourceUrl: string,
	html: string,
): ParsedPrice[] {
	const text = textContent(html);
	const currency = inferCurrency(text);
	const models = inferModelCandidates(text);
	return models.slice(0, 80).map((model) => {
		const prices = extractNearbyPrices(text, model);
		const input = prices[0] ?? 0;
		const output = prices.find((price) => price > input) ?? prices[1] ?? input;
		return priceFromValues({
			source,
			sourceUrl,
			model,
			currency,
			inputPrice: input,
			outputPrice: output,
			cacheReadPrice: input > 0 ? input / 4 : 0,
			cacheWritePrice: input,
			syncStatus: "estimated",
		});
	});
}

function dedupePrices(prices: ParsedPrice[]): ParsedPrice[] {
	const byKey = new Map<string, ParsedPrice>();
	for (const price of prices) {
		byKey.set(
			`${price.provider}:${price.canonical_model ?? price.model_pattern}`,
			price,
		);
	}
	return Array.from(byKey.values());
}

export function parsePricingPage(
	source: string,
	sourceUrl: string,
	html: string,
): ParsedPrice[] {
	if (source === "openrouter") {
		return parseOpenRouterPricing(sourceUrl, html);
	}
	if (source === "moonshot") {
		const moonshotPrices = parseMoonshotHomeCards(sourceUrl, html);
		if (moonshotPrices.length > 0) {
			return moonshotPrices;
		}
	}
	const exactPrices = dedupePrices([
		...parseJsonPricing(source, sourceUrl, html),
		...parseMatrixPricingTables(source, sourceUrl, html),
		...parseHtmlTables(source, sourceUrl, html),
	]);
	if (exactPrices.length > 0) {
		return exactPrices;
	}
	return parseEstimatedPricing(source, sourceUrl, html);
}

export async function syncModelPrices(
	db: D1Database,
	options: {
		sources: string[];
		fetcher?: typeof fetch;
		targetCurrency?: PricingCurrency;
		usdCnyRate?: number;
	} = { sources: Object.keys(PRICING_SOURCE_URLS) },
): Promise<PricingSyncResult> {
	const fetcher = options.fetcher ?? fetch;
	const targetCurrency = options.targetCurrency ?? "USD";
	const usdCnyRate =
		Number.isFinite(options.usdCnyRate) && Number(options.usdCnyRate) > 0
			? Number(options.usdCnyRate)
			: 1;
	const items: PricingSyncItem[] = [];
	for (const source of options.sources) {
		const sourceUrl = PRICING_SOURCE_URLS[source];
		if (!sourceUrl) {
			items.push({
				source,
				ok: false,
				count: 0,
				exact_count: 0,
				estimated_count: 0,
				message: "unknown_source",
			});
			continue;
		}
		try {
			const response = await fetcher(sourceUrl, {
				headers: {
					"user-agent": "api-worker-pricing-sync/1.0",
				},
			});
			if (!response.ok) {
				items.push({
					source,
					ok: false,
					count: 0,
					exact_count: 0,
					estimated_count: 0,
					message: `http_${response.status}`,
				});
				continue;
			}
			const html = await response.text();
			let parsedPrices = parsePricingPage(source, sourceUrl, html);
			let message = "synced";
			const fallbackConfig = OPENROUTER_FALLBACKS[source];
			if (parsedPrices.length === 0 && fallbackConfig) {
				const fallbackUrl = PRICING_SOURCE_URLS.openrouter;
				if (fallbackUrl) {
					const fallbackResponse = await fetcher(fallbackUrl, {
						headers: {
							"user-agent": "api-worker-pricing-sync/1.0",
						},
					});
					if (fallbackResponse.ok) {
						const fallbackBody = await fallbackResponse.text();
						parsedPrices = parseOpenRouterPricing(fallbackUrl, fallbackBody)
							.map((price) =>
								mapOpenRouterFallbackPrice(price, fallbackConfig, fallbackUrl),
							)
							.filter((price): price is ParsedPrice => Boolean(price));
						if (parsedPrices.length > 0) {
							message = "synced_from_openrouter";
						} else {
							message = "openrouter_fallback_empty";
						}
					} else {
						message = `openrouter_http_${fallbackResponse.status}`;
					}
				}
			}
			const prices = parsedPrices
				.map((price) => convertPriceCurrency(price, targetCurrency, usdCnyRate))
				.filter(
					(price) =>
						price.model_pattern &&
						(price.input_price_per_1m > 0 || price.output_price_per_1m > 0),
				);
			if (prices.length === 0) {
				await deleteSyncedModelPricesByProvider(db, source);
				items.push({
					source,
					ok: false,
					count: 0,
					exact_count: 0,
					estimated_count: 0,
					message: message === "synced" ? "no_prices_found" : message,
				});
				continue;
			}
			for (const provider of new Set(prices.map((price) => price.provider))) {
				await deleteSyncedModelPricesByProvider(db, provider);
			}
			for (const price of prices) {
				await upsertModelPrice(db, {
					...price,
					updated_at: nowIso(),
				});
			}
			const exactCount = prices.filter(
				(price) => price.sync_status === "exact",
			).length;
			const estimatedCount = prices.length - exactCount;
			items.push({
				source,
				ok: true,
				count: prices.length,
				exact_count: exactCount,
				estimated_count: estimatedCount,
				message,
			});
		} catch (error) {
			items.push({
				source,
				ok: false,
				count: 0,
				exact_count: 0,
				estimated_count: 0,
				message: error instanceof Error ? error.message : "sync_failed",
			});
		}
	}
	return {
		ok: items.some((item) => item.ok),
		runs_at: nowIso(),
		currency: targetCurrency,
		usd_cny_rate: usdCnyRate,
		items,
	};
}

function convertPriceCurrency(
	price: ParsedPrice,
	targetCurrency: PricingCurrency,
	usdCnyRate: number,
): ParsedPrice {
	return convertPriceFieldsCurrency(price, targetCurrency, usdCnyRate);
}
