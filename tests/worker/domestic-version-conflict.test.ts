import { describe, expect, it } from "vitest";
import { planCanonicalModelSync } from "../../apps/worker/src/services/canonical-model-registry";

describe("domestic model version conflict guard", () => {
	it("国产模型的主规则不会吞掉最新小版本", () => {
		const result = planCanonicalModelSync({
			rules: [
				{
					canonical_model: "deepseek/deepseek-v3",
					import_regex: "^(?:(?:deepseek|deepseek-ai)/)?deepseek-v3$",
				},
				{
					canonical_model: "deepseek/deepseek-v3.1",
					import_regex:
						"^(?:(?:deepseek|deepseek-ai)/)?deepseek-v3(?:[.-]1)(?:-terminus)?$",
				},
				{
					canonical_model: "deepseek/deepseek-v3.2",
					import_regex:
						"^(?:(?:deepseek|deepseek-ai)/)?deepseek-v3(?:[.-]2)(?:-\\d{6,8})?$",
				},
				{
					canonical_model: "deepseek/deepseek-v3.2-exp",
					import_regex:
						"^(?:(?:deepseek|deepseek-ai)/)?deepseek-v3(?:[.-]2)-exp$",
				},
				{
					canonical_model: "deepseek/deepseek-v3.2-speciale",
					import_regex:
						"^(?:(?:deepseek|deepseek-ai)/)?deepseek-v3(?:[.-]2)-speciale$",
				},
				{
					canonical_model: "moonshot/kimi-k2",
					import_regex:
						"^(?:(?:moonshot|moonshotai)/)?kimi-k2(?:[-:][\\w.]+)*$",
				},
				{
					canonical_model: "moonshot/kimi-k2.5",
					import_regex:
						"^(?:(?:moonshot|moonshotai)/)?kimi-k2\\.5(?:[-:][\\w.\\[\\]]+)*$",
				},
				{
					canonical_model: "moonshot/kimi-k2.6",
					import_regex:
						"^(?:(?:moonshot|moonshotai)/)?kimi-k2\\.6(?:[-:][\\w.]+)*$",
				},
				{
					canonical_model: "minimax/minimax-m2",
					import_regex:
						"^(?:(?:minimax|minimaxai)/)?minimax-m2(?:[-:][\\w-]+)*$",
				},
				{
					canonical_model: "minimax/minimax-m2.1",
					import_regex:
						"^(?:(?:minimax|minimaxai)/)?minimax-m2\\.1(?:[-:][\\w.]+)*$",
				},
				{
					canonical_model: "minimax/minimax-m2.5",
					import_regex:
						"^(?:(?:minimax|minimaxai)/)?minimax-m2\\.5(?:[-:][\\w.]+)*$",
				},
				{
					canonical_model: "minimax/minimax-m2.7",
					import_regex:
						"^(?:(?:minimax|minimaxai)/)?minimax-m2\\.7(?:[-:][\\w.]+)*$",
				},
				{
					canonical_model: "zhipu/glm-5",
					import_regex: "^(?:(?:zhipu|z-ai)/)?glm-?5(?:[-:][\\w.]+)*$",
				},
				{
					canonical_model: "zhipu/glm-5.1",
					import_regex: "^(?:(?:zhipu|z-ai)/)?glm-?5\\.1(?:[-:][\\w.]+)*$",
				},
				{
					canonical_model: "zhipu/glm-5v-turbo",
					import_regex: "^(?:(?:zhipu|z-ai)/)?glm-5v-turbo$",
				},
				{
					canonical_model: "alibaba/qwen3-coder",
					import_regex:
						"^(?:(?:alibaba|qwen)/)?qwen3-coder(?:-(?!(?:plus|flash|next|480b-a35b)\\b)[\\w.-]+)?$",
				},
				{
					canonical_model: "alibaba/qwen3-coder-480b-a35b",
					import_regex:
						"^(?:(?:alibaba|qwen)/)?qwen3-coder-480b-a35b(?:-instruct)?$",
				},
				{
					canonical_model: "alibaba/qwen3-next-80b-a3b",
					import_regex:
						"^(?:(?:alibaba|qwen)/)?qwen3-next-80b-a3b(?:-(?:instruct|thinking))?$",
				},
			],
			candidates: [
				{
					alias: "deepseek-v3-1-terminus",
					hits: 1,
					last_seen_at: null,
					sources: ["channel_capability"],
				},
				{
					alias: "deepseek-v3-2-251201",
					hits: 1,
					last_seen_at: null,
					sources: ["channel_capability"],
				},
				{
					alias: "deepseek-v3.2-exp",
					hits: 1,
					last_seen_at: null,
					sources: ["channel_capability"],
				},
				{
					alias: "deepseek-v3.2-speciale",
					hits: 1,
					last_seen_at: null,
					sources: ["channel_capability"],
				},
				{
					alias: "moonshotai/kimi-k2.6",
					hits: 1,
					last_seen_at: null,
					sources: ["channel_capability"],
				},
				{
					alias: "minimaxai/minimax-m2.7",
					hits: 1,
					last_seen_at: null,
					sources: ["channel_capability"],
				},
				{
					alias: "z-ai/glm-5.1",
					hits: 1,
					last_seen_at: null,
					sources: ["channel_capability"],
				},
				{
					alias: "z-ai/glm-5v-turbo",
					hits: 1,
					last_seen_at: null,
					sources: ["channel_capability"],
				},
				{
					alias: "qwen/qwen3-coder-480b-a35b-instruct",
					hits: 1,
					last_seen_at: null,
					sources: ["channel_capability"],
				},
				{
					alias: "qwen/qwen3-next-80b-a3b-instruct",
					hits: 1,
					last_seen_at: null,
					sources: ["channel_capability"],
				},
			],
			bindings: new Map(),
		});

		expect(result.conflicts).toEqual([]);
		expect(result.imported).toEqual([
			expect.objectContaining({
				alias: "deepseek-v3-1-terminus",
				canonical_model: "deepseek/deepseek-v3.1",
			}),
			expect.objectContaining({
				alias: "deepseek-v3-2-251201",
				canonical_model: "deepseek/deepseek-v3.2",
			}),
			expect.objectContaining({
				alias: "deepseek-v3.2-exp",
				canonical_model: "deepseek/deepseek-v3.2-exp",
			}),
			expect.objectContaining({
				alias: "deepseek-v3.2-speciale",
				canonical_model: "deepseek/deepseek-v3.2-speciale",
			}),
			expect.objectContaining({
				alias: "moonshotai/kimi-k2.6",
				canonical_model: "moonshot/kimi-k2.6",
			}),
			expect.objectContaining({
				alias: "minimaxai/minimax-m2.7",
				canonical_model: "minimax/minimax-m2.7",
			}),
			expect.objectContaining({
				alias: "z-ai/glm-5.1",
				canonical_model: "zhipu/glm-5.1",
			}),
			expect.objectContaining({
				alias: "z-ai/glm-5v-turbo",
				canonical_model: "zhipu/glm-5v-turbo",
			}),
			expect.objectContaining({
				alias: "qwen/qwen3-coder-480b-a35b-instruct",
				canonical_model: "alibaba/qwen3-coder-480b-a35b",
			}),
			expect.objectContaining({
				alias: "qwen/qwen3-next-80b-a3b-instruct",
				canonical_model: "alibaba/qwen3-next-80b-a3b",
			}),
		]);
	});
});
