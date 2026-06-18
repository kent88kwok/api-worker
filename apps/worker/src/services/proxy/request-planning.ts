import type { TokenRecord } from "../../middleware/tokenAuth";
import type { CallTokenItem } from "../call-token-selector";
import { resolveChannelAttemptTarget } from "../../domains/channel/attemptability";
import type { ChannelRecord } from "../../domains/channel/types";
import type { EndpointType, ProviderType } from "../provider-transform";
import { getProviderAdapter } from "../providers";
import { safeJsonParse } from "../../utils/json";
import { normalizeBaseUrl } from "../../utils/url";

export type RoutableChannelSkip = {
	channelId: string;
	channelName: string | null;
	reason: string;
	recordModel: string | null;
	upstreamProvider: ProviderType;
	hasModelList: boolean;
	tokenId: string | null;
	tokenName: string | null;
};

export function filterAllowedChannels(
	channels: ChannelRecord[],
	tokenRecord: TokenRecord,
): ChannelRecord[] {
	const allowed = safeJsonParse<string[] | null>(
		tokenRecord.allowed_channels,
		null,
	);
	if (!allowed || allowed.length === 0) {
		return channels;
	}
	const allowedSet = new Set(allowed);
	return channels.filter((channel) => allowedSet.has(channel.id));
}

export function resolveAttemptableChannels(options: {
	channels: ChannelRecord[];
	callTokenMap: Map<string, CallTokenItem[]>;
	downstreamModel: string | null;
	downstreamProvider: ProviderType;
	endpointType: EndpointType;
	verifiedModelsByChannel: Map<string, Set<string>>;
}): {
	channels: ChannelRecord[];
	skipped: RoutableChannelSkip[];
} {
	const routableChannels: ChannelRecord[] = [];
	const skipped: RoutableChannelSkip[] = [];
	for (const channel of options.channels) {
		const target = resolveChannelAttemptTarget({
			channel,
			tokens: options.callTokenMap.get(channel.id) ?? [],
			downstreamModel: options.downstreamModel,
			verifiedModelsByChannel: options.verifiedModelsByChannel,
			endpointType: options.endpointType,
			downstreamProvider: options.downstreamProvider,
		});
		if (target.eligible) {
			routableChannels.push(channel);
			continue;
		}
		skipped.push({
			channelId: channel.id,
			channelName: channel.name ?? null,
			reason: target.reason ?? "unknown",
			recordModel: target.recordModel,
			upstreamProvider: target.upstreamProvider,
			hasModelList: target.tokenSelection.hasModelList,
			tokenId: target.tokenSelection.token?.id ?? null,
			tokenName: target.tokenSelection.token?.name ?? null,
		});
	}
	return {
		channels: routableChannels,
		skipped,
	};
}

export function buildNoRoutableChannelsMeta(
	skipped: RoutableChannelSkip[],
): string {
	const reasonCounts: Record<string, number> = {};
	for (const item of skipped) {
		reasonCounts[item.reason] = (reasonCounts[item.reason] ?? 0) + 1;
	}
	return JSON.stringify({
		type: "channel_attemptability",
		reason_counts: reasonCounts,
		channels: skipped.slice(0, 20).map((item) => ({
			channel_id: item.channelId,
			channel_name: item.channelName,
			reason: item.reason,
			model: item.recordModel,
			upstream_provider: item.upstreamProvider,
			has_model_list: item.hasModelList,
			token_id: item.tokenId,
			token_name: item.tokenName,
		})),
	});
}

export function resolveChannelBaseUrl(channel: ChannelRecord): string {
	return normalizeBaseUrl(channel.base_url);
}

export function normalizeIncomingRequestPath(path: string): {
	path: string;
	rewritten: boolean;
} {
	if (!path) {
		return { path, rewritten: false };
	}
	const normalizedV1Beta = path.replace(/^\/v1beta(\/|$)/i, "/v1$1");
	const normalized = normalizedV1Beta.replace(/^\/v1(?:\/v1)+(\/|$)/i, "/v1$1");
	return {
		path: normalized,
		rewritten: normalized !== path,
	};
}

export function isOpenAiModelsListRequest(
	method: string,
	path: string,
): boolean {
	return method.toUpperCase() === "GET" && path.toLowerCase() === "/v1/models";
}

export function mergeQuery(
	base: string,
	querySuffix: string,
	overrides: Record<string, string>,
): string {
	const [path, rawQuery] = base.split("?");
	const params = new URLSearchParams(rawQuery ?? "");
	if (querySuffix) {
		const suffix = querySuffix.startsWith("?")
			? querySuffix.slice(1)
			: querySuffix;
		const suffixParams = new URLSearchParams(suffix);
		suffixParams.forEach((value, key) => {
			params.set(key, value);
		});
	}
	for (const [key, value] of Object.entries(overrides)) {
		params.set(key, value);
	}
	const query = params.toString();
	return query ? `${path}?${query}` : path;
}

export function buildUpstreamHeaders(
	baseHeaders: Headers,
	provider: ProviderType,
	apiKey: string,
	overrides: Record<string, string>,
): Headers {
	return getProviderAdapter(provider).buildAuthHeaders(
		baseHeaders,
		apiKey,
		overrides,
	);
}
