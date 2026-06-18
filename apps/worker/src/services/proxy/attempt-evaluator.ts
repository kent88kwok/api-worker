import { isResponsesToolCallNotFoundMessage as isResponsesToolCallNotFoundMessageShared } from "../../../../shared-core/src";
import {
	detectEndpointType,
	type EndpointType,
	type ProviderType,
} from "../provider-transform";
import type { CallTokenSelection } from "../../domains/channel/attemptability";
import type { ChannelRecord } from "../../domains/channel/types";
import type { RequestEntryFormat } from "../site-metadata";
import type { NormalizedUsage, StreamUsage } from "../../utils/usage";
import {
	formatUsageErrorMessage,
	normalizeMessage,
	normalizeUpstreamErrorCode,
} from "./shared";
import { isStreamOptionsUnsupportedMessage } from "./response-helpers";

export type SelectedAttemptState = {
	selectedChannel: ChannelRecord;
	selectedUpstreamProvider: ProviderType;
	selectedUpstreamEndpoint: EndpointType;
	selectedUpstreamModel: string | null;
	selectedCanonicalModel: string | null;
	selectedRequestPath: string;
	selectedRequestEntryFormat: RequestEntryFormat | null;
	selectedImmediateUsage: NormalizedUsage | null;
	selectedImmediateUsageSource: "json" | "header" | "none";
	selectedHasUsageSignal: boolean;
	selectedParsedStreamUsage: StreamUsage | null;
	selectedHasUsageHeaders: boolean;
	selectedAttemptTokenId: string | null;
	selectedAttemptTokenName: string | null;
	selectedAttemptIndex: number;
	selectedAttemptStartedAt: string;
	selectedAttemptLatencyMs: number;
	selectedAttemptUpstreamRequestId: string | null;
};

export function buildSelectedAttemptState(options: {
	channel: ChannelRecord;
	upstreamProvider: ProviderType;
	responsePath: string;
	requestEntryFormat: RequestEntryFormat | null;
	fallbackEndpointType: EndpointType;
	upstreamModel: string | null;
	canonicalModel: string | null;
	immediateUsage: NormalizedUsage | null;
	immediateUsageSource: "json" | "header" | "none";
	hasAnyUsageSignal: boolean;
	parsedSuccessStreamUsage: StreamUsage | null;
	hasUsageHeaderSignal: boolean;
	attemptNumber: number;
	attemptStartedAt: string;
	attemptLatencyMs: number;
	attemptUpstreamRequestId: string | null;
	tokenSelection?: CallTokenSelection | null;
}): SelectedAttemptState {
	let selectedUpstreamEndpoint: EndpointType;
	try {
		selectedUpstreamEndpoint = detectEndpointType(
			options.upstreamProvider,
			options.responsePath,
		);
	} catch {
		selectedUpstreamEndpoint = options.fallbackEndpointType;
	}
	return {
		selectedChannel: options.channel,
		selectedUpstreamProvider: options.upstreamProvider,
		selectedUpstreamEndpoint,
		selectedUpstreamModel: options.upstreamModel,
		selectedCanonicalModel: options.canonicalModel,
		selectedRequestPath: options.responsePath,
		selectedRequestEntryFormat: options.requestEntryFormat,
		selectedImmediateUsage: options.immediateUsage,
		selectedImmediateUsageSource: options.immediateUsageSource,
		selectedHasUsageSignal: options.hasAnyUsageSignal,
		selectedParsedStreamUsage: options.parsedSuccessStreamUsage,
		selectedHasUsageHeaders: options.hasUsageHeaderSignal,
		selectedAttemptTokenId: options.tokenSelection?.token?.id ?? null,
		selectedAttemptTokenName: options.tokenSelection?.token?.name ?? null,
		selectedAttemptIndex: options.attemptNumber,
		selectedAttemptStartedAt: options.attemptStartedAt,
		selectedAttemptLatencyMs: options.attemptLatencyMs,
		selectedAttemptUpstreamRequestId: options.attemptUpstreamRequestId,
	};
}

export function evaluateUpstreamHttpFailure(options: {
	errorCode: string | null;
	errorMessage: string | null;
	responseStatus: number;
	errorMetaJson: string | null;
	downstreamProvider: ProviderType;
	hasResponsesFunctionCallOutput: boolean;
	hasChatToolOutput: boolean;
	streamOptionsHandled: boolean;
}): {
	finalErrorCode: string;
	normalizedErrorMessage: string;
	errorMetaJson: string | null;
	errorClass:
		| "responses_tool_call_chain"
		| "stream_options"
		| "upstream_response";
	responsesToolCallMismatch: boolean;
} {
	const normalizedErrorCode = normalizeUpstreamErrorCode(
		options.errorCode,
		options.responseStatus,
	);
	const normalizedErrorMessage =
		normalizeMessage(options.errorMessage) ?? normalizedErrorCode;
	const responsesToolCallMismatch =
		options.downstreamProvider === "openai" &&
		(options.hasResponsesFunctionCallOutput || options.hasChatToolOutput) &&
		isResponsesToolCallNotFoundMessageShared(normalizedErrorMessage);
	const streamOptionsUnsupported =
		options.streamOptionsHandled &&
		isStreamOptionsUnsupportedMessage(normalizedErrorMessage);
	const finalErrorCode = responsesToolCallMismatch
		? "responses_tool_call_chain_mismatch"
		: streamOptionsUnsupported
			? "stream_options_unsupported"
			: normalizedErrorCode;
	return {
		finalErrorCode,
		normalizedErrorMessage,
		errorMetaJson: options.errorMetaJson,
		errorClass: responsesToolCallMismatch
			? "responses_tool_call_chain"
			: streamOptionsUnsupported
				? "stream_options"
				: "upstream_response",
		responsesToolCallMismatch,
	};
}

export function buildUsageMissingFailure(hasAnyUsageSignal: boolean): {
	errorCode: string;
	errorMessage: string;
} {
	const errorCode = hasAnyUsageSignal
		? "usage_missing.non_stream.signal_present_unparseable"
		: "usage_missing.non_stream.signal_absent";
	return {
		errorCode,
		errorMessage: `usage_missing: ${errorCode}`,
	};
}

export function buildZeroCompletionFailure(
	completionTokens: number | null | undefined,
): {
	errorCode: string;
	errorMessage: string;
} {
	const errorCode = "usage_zero_completion_tokens";
	return {
		errorCode,
		errorMessage: `${errorCode}: completion_tokens=${completionTokens ?? 0}`,
	};
}

export function buildFetchExceptionFailure(options: {
	error: unknown;
	maxLength: number;
	timeoutErrorCode: string;
	fetchErrorCode: string;
}): {
	isTimeout: boolean;
	errorCode: string;
	errorMessage: string;
	errorMetaJson: string;
} {
	const isTimeout =
		options.error instanceof Error &&
		(options.error.name === "AbortError" ||
			options.error.message.includes("upstream_timeout"));
	const errorCode = isTimeout
		? options.timeoutErrorCode
		: options.fetchErrorCode;
	const detail = normalizeMessage(
		options.error instanceof Error
			? options.error.message
			: String(options.error),
	);
	return {
		isTimeout,
		errorCode,
		errorMessage: formatUsageErrorMessage(errorCode, detail, options.maxLength),
		errorMetaJson: JSON.stringify({
			type: "fetch_exception",
			reason: isTimeout ? "timeout" : "exception",
		}),
	};
}
