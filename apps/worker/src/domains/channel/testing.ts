import type { D1Database } from "@cloudflare/workers-types";
import type { ProviderType } from "./metadata";
import { nowIso } from "../../utils/time";
import { upsertChannelModelCapabilities } from "./model-capabilities";
import { modelsToJson } from "./models";
import type { ModelDiscoveryResult } from "../../services/providers";
import type { SiteType } from "../../services/site-metadata";
import { discoverUpstreamModels } from "../../services/upstreams";

export type ChannelTestResult = ModelDiscoveryResult;

export type ChannelToken = {
	id?: string;
	name?: string;
	api_key: string;
};

export type ChannelTokenTestItem = {
	tokenId?: string;
	tokenName?: string;
	ok: boolean;
	elapsed: number;
	models: string[];
	httpStatus?: number | null;
	detail?: string | null;
};

export type ChannelTokenTestSummary = {
	ok: boolean;
	total: number;
	success: number;
	failed: number;
	elapsed: number;
	models: string[];
	items: ChannelTokenTestItem[];
};

export type FetchChannelModelsOptions = {
	provider?: ProviderType;
	siteType?: SiteType;
	fetcher?: typeof fetch;
};

export type ChannelModelsFetcher = (
	baseUrl: string,
	apiKey: string,
	options?: FetchChannelModelsOptions,
) => Promise<ChannelTestResult>;

export type ChannelTokenTestOptions = FetchChannelModelsOptions & {
	fetcher?: ChannelModelsFetcher;
};

export async function fetchChannelModels(
	baseUrl: string,
	apiKey: string,
	options: FetchChannelModelsOptions = {},
): Promise<ChannelTestResult> {
	return discoverUpstreamModels({
		siteType: options.siteType ?? options.provider ?? "new-api",
		baseUrl,
		apiKey,
		provider: options.provider,
		fetcher: options.fetcher,
	});
}

/**
 * Tests channel models with multiple API keys and aggregates results.
 *
 * Args:
 *   baseUrl: Upstream base URL.
 *   tokens: List of call tokens to test.
 *   fetcher: Optional fetcher override for tests.
 *
 * Returns:
 *   Summary of token test results and aggregated model IDs.
 */
export async function testChannelTokens(
	baseUrl: string,
	tokens: ChannelToken[],
	fetcherOrOptions:
		| ChannelModelsFetcher
		| ChannelTokenTestOptions = fetchChannelModels,
	maybeOptions: ChannelTokenTestOptions = {},
): Promise<ChannelTokenTestSummary> {
	if (tokens.length === 0) {
		return {
			ok: false,
			total: 0,
			success: 0,
			failed: 0,
			elapsed: 0,
			models: [],
			items: [],
		};
	}

	const fetcher =
		typeof fetcherOrOptions === "function"
			? fetcherOrOptions
			: (fetcherOrOptions.fetcher ?? fetchChannelModels);
	const provider =
		typeof fetcherOrOptions === "function"
			? maybeOptions.provider
			: fetcherOrOptions.provider;
	const siteType =
		typeof fetcherOrOptions === "function"
			? maybeOptions.siteType
			: fetcherOrOptions.siteType;
	const fetcherOptions =
		typeof fetcherOrOptions === "function" ? maybeOptions : fetcherOrOptions;
	const items: ChannelTokenTestItem[] = [];
	const modelSet = new Set<string>();
	let success = 0;
	let totalElapsed = 0;

	for (const token of tokens) {
		const result = await fetcher(baseUrl, token.api_key, {
			provider,
			siteType,
			fetcher: fetcherOptions.fetcher,
		});
		totalElapsed += result.elapsed;
		if (result.ok) {
			success += 1;
			for (const model of result.models) {
				modelSet.add(model);
			}
		}
		items.push({
			tokenId: token.id,
			tokenName: token.name,
			ok: result.ok,
			elapsed: result.elapsed,
			models: result.models,
			httpStatus: result.httpStatus ?? null,
			detail: result.detail ?? null,
		});
	}

	const total = tokens.length;
	const failed = total - success;
	const elapsed = Math.round(totalElapsed / total);

	return {
		ok: success > 0,
		total,
		success,
		failed,
		elapsed,
		models: Array.from(modelSet),
		items,
	};
}

export function summarizeChannelTokenFailures(
	items: ChannelTokenTestItem[],
): string | null {
	const failedItems = items.filter((item) => !item.ok);
	if (failedItems.length === 0) {
		return null;
	}
	const groups = new Map<
		string,
		{
			tokenLabels: string[];
			statusLabel: string;
			detail: string;
		}
	>();
	for (const item of failedItems) {
		const tokenLabel =
			String(item.tokenName ?? "").trim() ||
			String(item.tokenId ?? "").trim() ||
			"主调用令牌";
		const statusLabel =
			item.httpStatus === null || item.httpStatus === undefined
				? "请求失败"
				: `HTTP ${item.httpStatus}`;
		const detail = String(item.detail ?? "").trim();
		const groupKey = `${statusLabel}@@${detail}`;
		const current = groups.get(groupKey);
		if (current) {
			if (!current.tokenLabels.includes(tokenLabel)) {
				current.tokenLabels.push(tokenLabel);
			}
			continue;
		}
		groups.set(groupKey, {
			tokenLabels: [tokenLabel],
			statusLabel,
			detail,
		});
	}
	return Array.from(groups.values())
		.map((group) => {
			const tokenSummary = group.tokenLabels.join("、");
			return group.detail
				? `${tokenSummary}：${group.statusLabel} | ${group.detail}`
				: `${tokenSummary}：${group.statusLabel}`;
		})
		.join("；");
}

export async function updateChannelTestResult(
	db: D1Database,
	id: string,
	result: {
		ok: boolean;
		elapsed: number;
		models?: string[];
		modelsJson?: string;
	},
): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	const current = await db
		.prepare("SELECT status FROM channels WHERE id = ?")
		.bind(id)
		.first<{ status: string }>();
	const currentStatus = current?.status ?? "active";
	const status =
		currentStatus === "disabled" ? "disabled" : result.ok ? "active" : "error";
	const modelsJson =
		result.modelsJson ??
		(result.models ? modelsToJson(result.models) : undefined);
	const sql = modelsJson
		? "UPDATE channels SET status = ?, models_json = ?, test_time = ?, response_time_ms = ?, updated_at = ? WHERE id = ?"
		: "UPDATE channels SET status = ?, test_time = ?, response_time_ms = ?, updated_at = ? WHERE id = ?";

	const stmt = db.prepare(sql);
	if (modelsJson) {
		await stmt
			.bind(status, modelsJson, now, result.elapsed, nowIso(), id)
			.run();
	} else {
		await stmt.bind(status, now, result.elapsed, nowIso(), id).run();
	}
	if (result.ok && result.models && result.models.length > 0) {
		await upsertChannelModelCapabilities(db, id, result.models, now);
	}
}
