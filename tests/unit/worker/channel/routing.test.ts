import { describe, expect, it } from "vitest";
import {
	buildChannelAttemptPlan,
	selectCandidateChannels,
} from "../../../../apps/worker/src/domains/channel/routing";
import type { ChannelRecord } from "../../../../apps/worker/src/domains/channel/types";

function buildChannel(
	overrides: Partial<ChannelRecord> = {},
): ChannelRecord {
	return {
		id: "channel-a",
		name: "Channel A",
		base_url: "https://example.com",
		api_key: "test-key",
		weight: 1,
		status: "active",
		models_json: "[]",
		metadata_json: null,
		...overrides,
	};
}

describe("channel routing with effective models", () => {
	it("允许手动补充模型参与路由", () => {
		const channel = buildChannel({
			metadata_json: JSON.stringify({
				manual_include_models: ["manual-model"],
			}),
		});

		const candidates = selectCandidateChannels(
			[channel],
			"manual-model",
			new Map(),
		);

		expect(candidates.map((item) => item.id)).toEqual(["channel-a"]);
	});

	it("手动排除模型优先于验证通过模型", () => {
		const channel = buildChannel({
			metadata_json: JSON.stringify({
				manual_exclude_models: ["verified-model"],
			}),
		});

		const candidates = selectCandidateChannels(
			[channel],
			"verified-model",
			new Map([["channel-a", new Set(["verified-model"])]]),
		);

		expect(candidates).toEqual([]);
	});

	it("手动排除模型优先于显式模型映射", () => {
		const channel = buildChannel({
			metadata_json: JSON.stringify({
				model_mapping: {
					"blocked-model": "upstream-model",
				},
				manual_exclude_models: ["blocked-model"],
			}),
		});

		const candidates = selectCandidateChannels(
			[channel],
			"blocked-model",
			new Map([["channel-a", new Set(["upstream-model"])]]),
		);

		expect(candidates).toEqual([]);
	});

	it("models_json 作为自动来源参与路由", () => {
		const channel = buildChannel({
			models_json: JSON.stringify([{ id: "listed-only" }]),
		});

		const candidates = selectCandidateChannels(
			[channel],
			"listed-only",
			new Map([["channel-a", new Set(["verified-model"])]]),
		);

		expect(candidates.map((item) => item.id)).toEqual(["channel-a"]);
	});

	it("尝试计划会先排当前渠道的原始精确别名，再排同渠道其他候选", () => {
		const ordered = [
			buildChannel({
				id: "channel-a",
				name: "Channel A",
				metadata_json: JSON.stringify({
					site_type: "openai",
				}),
				models_json: JSON.stringify([
					{ id: "gpt-5.2" },
					{ id: "gpt-5.2-chat-latest" },
					{ id: "gpt-5.2-2026-05-01" },
				]),
			}),
			buildChannel({
				id: "channel-b",
				name: "Channel B",
				metadata_json: JSON.stringify({
					site_type: "openai",
				}),
				models_json: JSON.stringify([
					{ id: "gpt-5.2" },
					{ id: "gpt-5.2-mini" },
				]),
			}),
		];

		const plan = buildChannelAttemptPlan({
			ordered,
			downstreamModel: "gpt-5.2",
			requestModelRaw: "gpt-5.2-chat-latest",
			canonicalAliases: [
				"gpt-5.2",
				"gpt-5.2-chat-latest",
				"gpt-5.2-2026-05-01",
				"gpt-5.2-mini",
			],
			downstreamProvider: "openai",
			endpointType: "chat",
			maxAttempts: 6,
		});

		expect(
			plan.map(
				(item) =>
					`${item.channel.id}:${item.model}:${item.requestEntryFormat ?? "default"}`,
			),
		).toEqual([
			"channel-a:gpt-5.2-chat-latest:openai_chat",
			"channel-a:gpt-5.2:openai_chat",
			"channel-a:gpt-5.2-2026-05-01:openai_chat",
			"channel-b:gpt-5.2:openai_chat",
			"channel-b:gpt-5.2-mini:openai_chat",
		]);
	});

	it("正常请求不会把 canonical 名直接放进尝试计划", () => {
		const ordered = [
			buildChannel({
				id: "channel-a",
				name: "Channel A",
				metadata_json: JSON.stringify({
					site_type: "openai",
				}),
				models_json: JSON.stringify([
					{ id: "nvidia/llama-3.1-nemotron-51b-instruct" },
				]),
			}),
		];

		const plan = buildChannelAttemptPlan({
			ordered,
			downstreamModel: "llama-3.1-nemotron-51b",
			requestModelRaw: "llama-3.1-nemotron-51b",
			canonicalAliases: [
				"llama-3.1-nemotron-51b",
				"nvidia/llama-3.1-nemotron-51b-instruct",
			],
			downstreamProvider: "openai",
			endpointType: "chat",
			maxAttempts: 4,
		});

		expect(plan.map((item) => item.model)).toEqual([
			"nvidia/llama-3.1-nemotron-51b-instruct",
		]);
	});

	it("渠道存在标准上游名时优先把裸 canonical 请求转换成该渠道模型名", () => {
		const ordered = [
			buildChannel({
				id: "channel-a",
				name: "NVIDIA",
				metadata_json: JSON.stringify({
					site_type: "openai",
				}),
				models_json: JSON.stringify([
					{ id: "gemma-4-31b-t" },
					{ id: "google/gemma-4-31b-it" },
					{ id: "gemma-4-31b" },
				]),
			}),
		];

		const plan = buildChannelAttemptPlan({
			ordered,
			downstreamModel: "gemma-4-31b",
			requestModelRaw: "gemma-4-31b",
			canonicalAliases: [
				"gemma-4-31b",
				"gemma-4-31b-t",
				"google/gemma-4-31b-it",
			],
			downstreamProvider: "openai",
			endpointType: "chat",
			maxAttempts: 6,
		});

		expect(plan.map((item) => item.model)).toEqual([
			"google/gemma-4-31b-it",
			"gemma-4-31b",
			"gemma-4-31b-t",
		]);
	});
});
