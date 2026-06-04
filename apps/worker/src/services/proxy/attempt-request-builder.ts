import {
	buildUpstreamHeaders,
	mergeQuery,
	resolveChannelBaseUrl,
} from "./request-planning";
import { getProviderAdapter } from "../providers";
import type { EndpointType, ProviderType } from "../provider-transform";
import type { RequestEntryFormat } from "../site-metadata";
import { resolveAttemptRequestBuildPlan } from "./request-build-plan";
import { executeAttemptRequestBuildPlan } from "./request-build-strategy";
import { applyAttemptStreamOptionsPolicy } from "./request-stream-options-policy";

export type PreparedAttemptRequest = {
	upstreamProvider: string;
	upstreamModel: string | null;
	recordModel: string | null;
	tokenSelection: any;
	headers: Headers;
	target: string;
	fallbackTarget?: string;
	responsePath: string;
	fallbackPath?: string;
	bodyText?: string;
	streamOptionsHandled: boolean;
	streamOptionsInjected: boolean;
	strippedBodyText?: string;
	requestEntryFormatToPersist?: RequestEntryFormat;
	requestEntryPathToPersist?: string;
};

/**
 * Builds a normalized upstream request for one candidate channel attempt.
 *
 * Returns `null` when the attempt should be skipped for this channel.
 */
export async function prepareAttemptRequest(options: {
	channel: any;
	attemptTarget: any;
	upstreamModelOverride?: string | null;
	recordModelOverride?: string | null;
	requestEntryFormatOverride?: RequestEntryFormat | null;
	requestHeaders: Headers;
	targetPath: string;
	effectiveRequestText: string;
	parsedBody: Record<string, unknown> | null;
	downstreamProvider: ProviderType;
	endpointType: EndpointType;
	isStream: boolean;
	shouldSkipHeavyBodyParsing: boolean;
	querySuffix: string;
	upstreamTimeoutMs: number;
	streamUsageOptions: any;
	ensureNormalizedChat: () => any;
	ensureNormalizedEmbedding: () => any;
	ensureNormalizedImage: () => any;
	loadStreamOptionsCapability: (
		channelId: string,
	) => Promise<"supported" | "unsupported" | "unknown">;
}): Promise<PreparedAttemptRequest | null> {
	const metadata = options.attemptTarget.metadata;
	const upstreamModel =
		options.upstreamModelOverride ?? options.attemptTarget.upstreamModel;
	const recordModel =
		options.recordModelOverride ?? options.attemptTarget.recordModel;
	const tokenSelection = options.attemptTarget.tokenSelection;

	const baseUrl = resolveChannelBaseUrl(options.channel);
	const apiKey = tokenSelection.token?.api_key ?? options.channel.api_key;

	let upstreamRequestPath = options.targetPath;
	let upstreamFallbackPath: string | undefined;
	let upstreamBodyText = options.effectiveRequestText || undefined;
	let absoluteUrl: string | undefined;
	const buildPlan = resolveAttemptRequestBuildPlan({
		attemptUpstreamProvider: options.attemptTarget.upstreamProvider,
		siteType: metadata.site_type,
		requestEntry: metadata.request_entry,
		downstreamProvider: options.downstreamProvider,
		endpointType: options.endpointType,
		requestEntryFormatOverride: options.requestEntryFormatOverride,
	});
	if (!buildPlan) {
		return null;
	}
	const upstreamProvider = buildPlan.upstreamProvider;

	const providerAdapter = getProviderAdapter(upstreamProvider);
	const headers = buildUpstreamHeaders(
		new Headers(options.requestHeaders),
		upstreamProvider,
		String(apiKey),
		metadata.header_overrides,
	);
	headers.delete("host");
	headers.delete("content-length");
	const builtRequest = executeAttemptRequestBuildPlan({
		plan: buildPlan,
		initialPath: upstreamRequestPath,
		initialBodyText: upstreamBodyText,
		initialTargetPath: options.targetPath,
		upstreamModel,
		parsedBody: options.parsedBody,
		applyModelToPath: providerAdapter.applyModelToPath.bind(providerAdapter),
		normalizedChatRequest:
			options.endpointType === "chat" || options.endpointType === "responses"
				? options.ensureNormalizedChat()
				: null,
		normalizedEmbeddingRequest:
			options.endpointType === "embeddings"
				? options.ensureNormalizedEmbedding()
				: null,
		normalizedImageRequest:
			options.endpointType === "images"
				? options.ensureNormalizedImage()
				: null,
		isStream: options.isStream,
		endpointOverrides: metadata.endpoint_overrides,
	});
	if (!builtRequest) {
		return null;
	}
	upstreamRequestPath = builtRequest.upstreamRequestPath;
	upstreamFallbackPath = builtRequest.upstreamFallbackPath;
	upstreamBodyText = builtRequest.upstreamBodyText;
	absoluteUrl = builtRequest.absoluteUrl;

	const streamPolicy = await applyAttemptStreamOptionsPolicy({
		channelId: options.channel.id,
		upstreamProvider,
		isStream: options.isStream,
		endpointType: options.endpointType,
		shouldSkipHeavyBodyParsing: options.shouldSkipHeavyBodyParsing,
		bodyText: upstreamBodyText,
		loadStreamOptionsCapability: options.loadStreamOptionsCapability,
	});
	upstreamBodyText = streamPolicy.bodyText;

	const targetBase = absoluteUrl ?? `${baseUrl}${upstreamRequestPath}`;
	const target = mergeQuery(
		targetBase,
		options.querySuffix,
		metadata.query_overrides,
	);
	const fallbackTarget =
		upstreamFallbackPath && !absoluteUrl
			? mergeQuery(
					`${baseUrl}${upstreamFallbackPath}`,
					options.querySuffix,
					metadata.query_overrides,
				)
			: undefined;

	return {
		upstreamProvider,
		upstreamModel,
		recordModel,
		tokenSelection,
		headers,
		target,
		fallbackTarget,
		responsePath: upstreamRequestPath,
		fallbackPath: upstreamFallbackPath,
		bodyText: upstreamBodyText,
		streamOptionsHandled: streamPolicy.streamOptionsHandled,
		streamOptionsInjected: streamPolicy.streamOptionsInjected,
		strippedBodyText: streamPolicy.strippedBodyText,
		requestEntryFormatToPersist: buildPlan.requestEntryFormatToPersist,
		requestEntryPathToPersist: metadata.request_entry?.path ?? undefined,
	};
}
