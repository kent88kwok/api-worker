import { describe, expect, it } from "vitest";
import {
	resolveChannelAttemptTarget,
	selectTokenForModel,
} from "../../../../apps/worker/src/domains/channel/attemptability";

describe("channel attemptability", () => {
	it("存在未同步模型列表的 token 时，仍应允许命中该 token", () => {
		const selection = selectTokenForModel(
			[
				{
					id: "token-stale",
					name: "Stale",
					api_key: "sk-stale",
					models_json: JSON.stringify(["gpt-4o-mini"]),
				},
				{
					id: "token-unknown",
					name: "Unknown",
					api_key: "sk-unknown",
					models_json: null,
				},
			],
			"gpt-4.1",
		);

		expect(selection.hasModelList).toBe(true);
		expect(selection.token?.id).toBe("token-unknown");
	});

	it("路由阶段不应因为部分 token 模型快照过期就过滤可用渠道", () => {
		const target = resolveChannelAttemptTarget({
			channel: {
				id: "channel-a",
				name: "Channel A",
				base_url: "https://example.com",
				api_key: "site-key",
				weight: 1,
				status: "active",
				models_json: JSON.stringify([{ id: "gpt-4.1" }]),
				metadata_json: JSON.stringify({
					site_type: "openai",
				}),
			},
			tokens: [
				{
					id: "token-stale",
					channel_id: "channel-a",
					name: "Stale",
					api_key: "sk-stale",
					models_json: JSON.stringify(["gpt-4o-mini"]),
				},
				{
					id: "token-unknown",
					channel_id: "channel-a",
					name: "Unknown",
					api_key: "sk-unknown",
					models_json: null,
				},
			],
			downstreamModel: "gpt-4.1",
			verifiedModelsByChannel: new Map([["channel-a", new Set(["gpt-4.1"])]]),
			endpointType: "chat",
			downstreamProvider: "openai",
		});

		expect(target.eligible).toBe(true);
		expect(target.reason).toBeNull();
		expect(target.tokenSelection.token?.id).toBe("token-unknown");
	});
});
