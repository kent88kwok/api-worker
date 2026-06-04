import { describe, expect, it } from "vitest";
import { resolveAttemptRequestBuildPlan } from "../../apps/worker/src/services/proxy/request-build-plan";

describe("attempt request build plan", () => {
	it("同 provider 的自定义入口保留原始 body，只改目标入口", () => {
		const plan = resolveAttemptRequestBuildPlan({
			attemptUpstreamProvider: "openai",
			siteType: "openai",
			requestEntry: {
				path: "/codex",
				format: null,
			},
			downstreamProvider: "openai",
			endpointType: "chat",
			requestEntryFormatOverride: null,
		});

		expect(plan).toMatchObject({
			upstreamProvider: "openai",
			requestEndpointType: "chat",
			strategy: "reuse_custom_entry_body",
			customEntry: {
				path: "/codex",
				upstreamProvider: "openai",
			},
		});
	});

	it("跨 provider 的 chat 请求会走重建策略", () => {
		const plan = resolveAttemptRequestBuildPlan({
			attemptUpstreamProvider: "openai",
			siteType: "subapi",
			requestEntry: {
				path: null,
				format: null,
			},
			downstreamProvider: "openai",
			endpointType: "chat",
			requestEntryFormatOverride: "anthropic_messages",
		});

		expect(plan).toMatchObject({
			upstreamProvider: "anthropic",
			requestEndpointType: "chat",
			strategy: "rebuild_chat",
		});
	});

	it("同 provider 的 embeddings 请求只做模型改写", () => {
		const plan = resolveAttemptRequestBuildPlan({
			attemptUpstreamProvider: "openai",
			siteType: "openai",
			requestEntry: {
				path: null,
				format: null,
			},
			downstreamProvider: "openai",
			endpointType: "embeddings",
			requestEntryFormatOverride: null,
		});

		expect(plan).toMatchObject({
			upstreamProvider: "openai",
			requestEndpointType: "embeddings",
			strategy: "rewrite_model",
		});
	});

	it("跨 provider 的 passthrough 请求直接跳过", () => {
		const plan = resolveAttemptRequestBuildPlan({
			attemptUpstreamProvider: "openai",
			siteType: "subapi",
			requestEntry: {
				path: null,
				format: null,
			},
			downstreamProvider: "openai",
			endpointType: "passthrough",
			requestEntryFormatOverride: "anthropic_messages",
		});

		expect(plan).toBeNull();
	});
});
