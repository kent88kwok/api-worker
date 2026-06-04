import { buildProviderChatRequest } from "../providers/chat-request";
import {
	buildProviderEmbeddingRequest,
	buildProviderImageRequest,
} from "../providers/requests";
import type {
	NormalizedChatRequest,
	NormalizedEmbeddingRequest,
	NormalizedImageRequest,
	UpstreamRequest,
} from "../provider-transform";
import type { EndpointOverrides } from "../site-metadata";
import { rewriteModelInRawJsonRequest } from "./request-body";
import type { AttemptRequestBuildPlan } from "./request-build-plan";

export type ExecutedAttemptRequestBuild = {
	upstreamRequestPath: string;
	upstreamFallbackPath?: string;
	upstreamBodyText?: string;
	absoluteUrl?: string;
};

export function executeAttemptRequestBuildPlan(options: {
	plan: AttemptRequestBuildPlan;
	initialPath: string;
	initialBodyText?: string;
	initialTargetPath: string;
	upstreamModel: string | null;
	parsedBody: Record<string, unknown> | null;
	applyModelToPath: (path: string, model: string | null) => string;
	normalizedChatRequest?: NormalizedChatRequest | null;
	normalizedEmbeddingRequest?: NormalizedEmbeddingRequest | null;
	normalizedImageRequest?: NormalizedImageRequest | null;
	isStream: boolean;
	endpointOverrides: EndpointOverrides;
}): ExecutedAttemptRequestBuild | null {
	if (options.plan.strategy === "reuse_custom_entry_body") {
		return {
			upstreamRequestPath:
				options.plan.customEntry?.path ?? options.initialPath,
			absoluteUrl: options.plan.customEntry?.absoluteUrl,
			upstreamBodyText: options.initialBodyText,
		};
	}

	if (options.plan.strategy === "rewrite_model") {
		const upstreamRequestPath = options.applyModelToPath(
			options.plan.customEntry?.path ?? options.initialPath,
			options.upstreamModel,
		);
		let upstreamBodyText = options.initialBodyText;
		if (
			upstreamRequestPath === options.initialTargetPath &&
			options.upstreamModel
		) {
			upstreamBodyText = options.parsedBody
				? JSON.stringify({
						...options.parsedBody,
						model: options.upstreamModel,
					})
				: rewriteModelInRawJsonRequest(
						options.initialBodyText,
						options.upstreamModel,
					);
		}
		return {
			upstreamRequestPath,
			absoluteUrl: options.plan.customEntry?.absoluteUrl,
			upstreamBodyText,
		};
	}

	let request: UpstreamRequest | null = null;
	if (options.plan.strategy === "rebuild_chat") {
		if (!options.normalizedChatRequest) {
			return null;
		}
		request = buildProviderChatRequest(
			options.plan.upstreamProvider,
			options.normalizedChatRequest,
			options.upstreamModel,
			options.plan.requestEndpointType,
			options.isStream,
			options.endpointOverrides,
		);
	}
	if (options.plan.strategy === "rebuild_embedding") {
		if (!options.normalizedEmbeddingRequest) {
			return null;
		}
		request = buildProviderEmbeddingRequest(
			options.plan.upstreamProvider,
			options.normalizedEmbeddingRequest,
			options.upstreamModel,
			options.endpointOverrides,
		);
	}
	if (options.plan.strategy === "rebuild_image") {
		if (!options.normalizedImageRequest) {
			return null;
		}
		request = buildProviderImageRequest(
			options.plan.upstreamProvider,
			options.normalizedImageRequest,
			options.upstreamModel,
			options.endpointOverrides,
		);
	}

	if (!request) {
		return null;
	}

	return {
		upstreamRequestPath: options.plan.customEntry?.path ?? request.path,
		absoluteUrl: options.plan.customEntry?.absoluteUrl ?? request.absoluteUrl,
		upstreamFallbackPath:
			options.plan.customEntry?.path || options.plan.customEntry?.absoluteUrl
				? undefined
				: request.absoluteUrl
					? undefined
					: request.fallbackPath,
		upstreamBodyText: request.body ? JSON.stringify(request.body) : undefined,
	};
}
