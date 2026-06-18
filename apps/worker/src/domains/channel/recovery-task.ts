import { testChannelTokens, type ChannelTokenTestSummary } from "./testing";
import { resolveUpstreamProvider } from "../../services/upstreams";
import { normalizeChatRequest } from "../../services/provider-transform";
import type {
	SiteTaskProbeChannel,
	SiteTaskProbeResult,
	SiteTaskToken,
} from "../../services/site-task-contract";
import { normalizeBaseUrl } from "../../utils/url";
import { getProviderAdapter } from "../../services/providers";
import { buildProviderChatRequest } from "../../services/providers/chat-request";
import { inspectSuccessfulResponse } from "../../services/successful-response";

const RECOVERY_PROBE_PROMPT = "Reply with a short health-check message.";
const RECOVERY_PROBE_MAX_TOKENS = 32;

export function pickRandomItem<T>(
	items: readonly T[],
	random: () => number = Math.random,
): T | null {
	if (items.length === 0) {
		return null;
	}
	const index = Math.floor(random() * items.length);
	const safeIndex = Math.max(0, Math.min(items.length - 1, index));
	return items[safeIndex] ?? null;
}

async function sendCompletionProbe(options: {
	baseUrl: string;
	apiKey: string;
	model: string;
	provider?: "openai" | "anthropic" | "gemini";
	fetcher?: typeof fetch;
}): Promise<boolean> {
	const fetcher = options.fetcher ?? fetch;
	const providerAdapter = getProviderAdapter(options.provider ?? "openai");
	const normalized = normalizeChatRequest(
		"openai",
		"chat",
		{
			model: options.model,
			messages: [{ role: "user", content: RECOVERY_PROBE_PROMPT }],
			max_tokens: RECOVERY_PROBE_MAX_TOKENS,
			temperature: 0,
			stream: false,
		},
		options.model,
		false,
	);
	if (!normalized) {
		return false;
	}
	const request = buildProviderChatRequest(
		options.provider ?? "openai",
		normalized,
		options.model,
		"chat",
		false,
		{},
	);
	if (!request) {
		return false;
	}
	const target = request.absoluteUrl
		? request.absoluteUrl
		: `${normalizeBaseUrl(options.baseUrl)}${request.path}`;
	const headers = providerAdapter.buildAuthHeaders(
		new Headers({ "Content-Type": "application/json" }),
		options.apiKey,
		{},
	);
	let response: Response;
	try {
		response = await fetcher(target, {
			method: "POST",
			headers,
			body: JSON.stringify(request.body),
		});
	} catch {
		return false;
	}
	if (!response.ok) {
		return false;
	}
	const inspection = await inspectSuccessfulResponse(response, {
		expectedProvider: options.provider ?? "openai",
		requireOutputText: true,
	});
	return inspection.ok;
}

function buildProbeTokens(
	channel: SiteTaskProbeChannel,
	tokens: SiteTaskToken[],
): SiteTaskToken[] {
	if (tokens.length > 0) {
		return tokens;
	}
	const fallbackApiKey = String(channel.api_key ?? "").trim();
	if (!fallbackApiKey) {
		return [];
	}
	return [
		{
			id: "primary",
			name: "primary",
			api_key: fallbackApiKey,
		},
	];
}

function selectSuccessfulToken(
	summary: ChannelTokenTestSummary,
	random: () => number,
) {
	const successfulItems = summary.items.filter(
		(item) => item.ok && item.models.length > 0,
	);
	return pickRandomItem(successfulItems, random);
}

export async function runDisabledChannelRecoveryProbe(
	channel: SiteTaskProbeChannel,
	tokens: SiteTaskToken[],
	options: {
		random?: () => number;
		fetcher?: typeof fetch;
	} = {},
): Promise<SiteTaskProbeResult> {
	const random = options.random ?? Math.random;
	const probeTokens = buildProbeTokens(channel, tokens);
	if (probeTokens.length === 0) {
		return {
			attempted: true,
			recovered: false,
			reason: "missing_token",
			channel_id: channel.id,
			channel_name: channel.name,
			elapsed: 0,
			models: [],
			items: [],
		};
	}

	const summary = await testChannelTokens(channel.base_url, probeTokens, {
		siteType: channel.siteType,
		provider: channel.provider,
	});
	if (!summary.ok) {
		return {
			attempted: true,
			recovered: false,
			reason: "token_model_test_failed",
			channel_id: channel.id,
			channel_name: channel.name,
			elapsed: summary.elapsed,
			models: summary.models,
			items: summary.items,
		};
	}

	const selectedToken = selectSuccessfulToken(summary, random);
	const model = pickRandomItem(selectedToken?.models ?? [], random);
	if (!selectedToken || !model) {
		return {
			attempted: true,
			recovered: false,
			reason: "completion_probe_failed",
			channel_id: channel.id,
			channel_name: channel.name,
			elapsed: summary.elapsed,
			models: summary.models,
			items: summary.items,
		};
	}

	const matchingToken = probeTokens.find(
		(token) =>
			(token.id ?? "") === (selectedToken.tokenId ?? "") &&
			token.api_key.trim().length > 0,
	);
	const probeApiKey = matchingToken?.api_key ?? "";
	const probeOk =
		probeApiKey.length > 0
			? await sendCompletionProbe({
					baseUrl: channel.base_url,
					apiKey: probeApiKey,
					model,
					provider: resolveUpstreamProvider(
						channel.siteType ?? channel.provider ?? "new-api",
						channel.provider,
					),
					fetcher: options.fetcher,
				})
			: false;

	return {
		attempted: true,
		recovered: probeOk,
		reason: probeOk ? "recovered" : "completion_probe_failed",
		channel_id: channel.id,
		channel_name: channel.name,
		model,
		elapsed: summary.elapsed,
		models: summary.models,
		items: summary.items,
	};
}
