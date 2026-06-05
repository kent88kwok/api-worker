import { describe, expect, it } from "vitest";
import { runProxyAttempts } from "../../apps/worker/src/services/proxy/attempt-runner";

function createRunnerContext(options?: {
	persist?: (payload: Record<string, unknown>) => Promise<void>;
}) {
	const channel = {
		id: "ch_test",
		name: "Test Channel",
		api_key: "sk-test",
		metadata_json: JSON.stringify({
			site_type: "openai",
			request_entry: {
				path: "/codex",
				format: null,
			},
		}),
	};
	const db = { name: "db" };
	const kvHot = { name: "kv-hot" };
	return {
		ordered: [],
		attemptPlan: [{ channel, model: null }],
		callTokenMap: new Map([[channel.id, []]]),
		downstreamModel: "gpt-5",
		canonicalModel: "openai/gpt-5",
		requestModelRaw: "gpt-5",
		verifiedModelsByChannel: new Map(),
		endpointType: "chat",
		downstreamProvider: "openai",
		traceId: "trace-1",
		shouldTryLargeRequestDispatch: false,
		prepareAttemptRequest: async () => ({
			upstreamProvider: "openai",
			upstreamModel: "gpt-5",
			recordModel: "gpt-5",
			tokenSelection: {
				token: {
					id: "token-1",
					name: "Token 1",
					api_key: "sk-test",
				},
			},
			headers: new Headers(),
			target: "https://example.com/codex",
			responsePath: "/codex",
			bodyText: '{"model":"gpt-5"}',
			streamOptionsHandled: false,
			streamOptionsInjected: false,
			requestEntryFormatToPersist: "openai_chat",
			requestEntryPathToPersist: "/codex",
		}),
		c: {
			req: {
				method: "POST",
				header: () => ({}),
			},
			env: {
				DB: db,
				KV_HOT: kvHot,
			},
		},
		targetPath: "/v1/chat/completions",
		effectiveRequestText: '{"model":"gpt-5"}',
		parsedBody: { model: "gpt-5" },
		isStream: false,
		shouldSkipHeavyBodyParsing: false,
		querySuffix: "",
		upstreamTimeoutMs: 10_000,
		streamUsageOptions: {},
		ensureNormalizedChat: () => null,
		ensureNormalizedEmbedding: () => null,
		ensureNormalizedImage: () => null,
		loadStreamOptionsCapability: async () => "unknown",
		attemptBindingPolicy: null,
		attemptBindingState: null,
		dispatchRetryConfig: null,
		downstreamSignal: null,
		downstreamAbortResponse: () => new Response(null, { status: 499 }),
		recordEarlyUsage: () => undefined,
		jsonErrorWithTrace: (status: number) => new Response(null, { status }),
		hasUsageHeaders: () => false,
		hasUsageJsonHint: () => false,
		parseUsageFromHeaders: () => null,
		parseUsageFromJson: () => null,
		parseBooleanHeader: () => false,
		ATTEMPT_STREAM_USAGE_PROCESSED_HEADER: "x-attempt-stream-usage-processed",
		parseOptionalLatencyHeader: () => null,
		ATTEMPT_STREAM_FIRST_TOKEN_LATENCY_HEADER:
			"x-attempt-stream-first-token-latency",
		parseOptionalCountHeader: () => null,
		ATTEMPT_STREAM_EVENTS_SEEN_HEADER: "x-attempt-stream-events-seen",
		readAttemptStreamAbnormal: () => null,
		shouldParseSuccessStreamUsage: () => false,
		streamUsageMode: "off",
		parseUsageFromSse: async () => null,
		streamUsageParseTimeoutMs: 0,
		detectAbnormalSuccessResponse: async () => null,
		detectAbnormalStreamSuccessResponse: async () => null,
		resolveFailureWithMeta: () => ({
			action: "retry",
			errorMetaJson: null,
		}),
		recordAttemptUsage: () => undefined,
		recordAttemptLog: () => undefined,
		appendAttemptFailure: () => undefined,
		scheduleModelCooldown: () => undefined,
		applyDisableAction: async () => undefined,
		continueAfterFailure: async () => true,
		buildDirectErrorResponse: (status: number) =>
			new Response(null, { status }),
		shouldTreatMissingUsageAsError: () => false,
		parsedBodyInitialized: true,
		buildUsageMissingFailure: () => ({
			errorCode: "missing_usage",
			errorMessage: "missing usage",
		}),
		shouldTreatZeroCompletionAsError: () => false,
		zeroCompletionAsErrorEnabled: false,
		buildZeroCompletionFailure: () => ({
			errorCode: "zero_completion",
			errorMessage: "zero completion",
		}),
		buildSelectedAttemptState: (payload: {
			channel: typeof channel;
			upstreamProvider: string;
			upstreamModel: string | null;
			canonicalModel: string;
			responsePath: string;
			immediateUsage: unknown;
			immediateUsageSource: string;
			hasAnyUsageSignal: boolean;
		}) => ({
			selectedChannel: payload.channel,
			selectedUpstreamProvider: payload.upstreamProvider,
			selectedUpstreamEndpoint: "chat",
			selectedUpstreamModel: payload.upstreamModel,
			selectedCanonicalModel: payload.canonicalModel,
			selectedRequestPath: payload.responsePath,
			selectedImmediateUsage: payload.immediateUsage,
			selectedImmediateUsageSource: payload.immediateUsageSource,
			selectedHasUsageSignal: payload.hasAnyUsageSignal,
			selectedParsedStreamUsage: null,
			selectedHasUsageHeaders: false,
			selectedAttemptIndex: 1,
			selectedAttemptStartedAt: "2026-06-04T00:00:00.000Z",
			selectedAttemptLatencyMs: 12,
			selectedAttemptUpstreamRequestId: "req_123",
		}),
		scheduleUsageEvent: () => undefined,
		nowSeconds: () => 0,
		extractErrorDetails: async () => ({
			errorCode: "upstream_error",
			errorMessage: "upstream error",
		}),
		mergeErrorMetaJson: () => null,
		buildUpstreamDiagnosticMeta: () => null,
		parseStreamUsageOnFailure: async () => ({
			usage: null,
			usageSource: "none",
		}),
		evaluateUpstreamHttpFailure: () => ({
			finalErrorCode: "upstream_error",
			normalizedErrorMessage: "upstream error",
			errorMetaJson: null,
			errorClass: "upstream_response",
			responsesToolCallMismatch: false,
		}),
		responsesRequestHints: null,
		hasChatToolOutput: false,
		buildFetchExceptionFailure: () => ({
			errorCode: "fetch_error",
			errorMessage: "fetch error",
		}),
		usageErrorMessageMaxLength: 1_000,
		PROXY_UPSTREAM_TIMEOUT_ERROR_CODE: "proxy_upstream_timeout",
		PROXY_UPSTREAM_FETCH_ERROR_CODE: "proxy_upstream_fetch_error",
		executeAttemptViaWorker: async () => ({
			response: new Response("ok", { status: 200 }),
			responsePath: "/codex",
			latencyMs: 12,
			upstreamRequestId: "req_123",
		}),
		executeDispatchViaWorker: async () => null,
		isStreamOptionsUnsupportedMessage: () => false,
		saveStreamOptionsCapability: () => undefined,
		resolveChannelAttemptTarget: () => ({
			eligible: true,
			upstreamModel: "gpt-5",
			recordModel: "gpt-5",
			canonicalModel: "openai/gpt-5",
		}),
		recordSelectedClientDisconnect: () => undefined,
		persistAutomaticRequestEntryFormat:
			options?.persist ??
			(async () => {
				return;
			}),
		state: {
			selectedResponse: null,
			selectedChannel: null,
			selectedAttemptTokenId: null,
			selectedAttemptTokenName: null,
			selectedUpstreamProvider: null,
			selectedUpstreamEndpoint: null,
			selectedUpstreamModel: null,
			selectedCanonicalModel: null,
			selectedRequestPath: null,
			selectedImmediateUsage: null,
			selectedImmediateUsageSource: null,
			selectedHasUsageSignal: false,
			selectedParsedStreamUsage: null,
			selectedHasUsageHeaders: false,
			selectedAttemptIndex: null,
			selectedAttemptStartedAt: null,
			selectedAttemptLatencyMs: null,
			selectedAttemptUpstreamRequestId: null,
			lastErrorDetails: null,
			attemptsExecuted: 0,
			responsesToolCallMismatchChannels: [],
			attemptFailures: [],
			blockedChannelIds: new Set<string>(),
		},
	};
}

describe("attempt runner request entry persistence", () => {
	it("自动请求入口成功后不会回写明确请求格式", async () => {
		const persistedPayloads: Record<string, unknown>[] = [];
		const ctx = createRunnerContext({
			persist: async (payload) => {
				persistedPayloads.push(payload);
			},
		});

		await runProxyAttempts(ctx);

		expect(persistedPayloads).toEqual([]);
	});
});
