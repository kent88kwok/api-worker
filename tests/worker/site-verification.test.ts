import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/worker/src/services/provider-transform", () => ({
	normalizeChatRequest: vi.fn(() => ({ messages: [], stream: false })),
}));

vi.mock("../../apps/worker/src/services/providers/chat-request", () => ({
	buildProviderChatRequest: (
		provider: string,
		_normalized: unknown,
		model: string | null,
		endpoint: string,
	): {
		path: string;
		body: Record<string, unknown>;
	} | null => {
		if (!model) {
			return null;
		}
		return {
			path:
				endpoint === "responses" ? "/v1/responses" : "/v1/chat/completions",
			body: {
				model,
			},
		};
	},
}));

import { verifySiteChannel } from "../../apps/worker/src/services/site-verification";

const originalFetch = globalThis.fetch;

function createOpenAiChannel(models: string[]) {
	return {
		id: "ch_test",
		name: "test-openai",
		base_url: "https://example.com",
		api_key: "sk-test",
		weight: 1,
		status: "active",
		models_json: JSON.stringify(models.map((id) => ({ id }))),
		metadata_json: JSON.stringify({
			site_type: "openai",
			request_entry: {
				path: null,
				format: null,
			},
		}),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.fetch = originalFetch;
});

describe("site verification", () => {
	it("网络错误会按现有请求规则继续尝试后续请求格式", async () => {
		const postCalls: Array<{ path: string; model: string }> = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/v1/models")) {
				return Response.json({
					data: [{ id: "gpt-4.1" }],
				});
			}
			const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
			postCalls.push({
				path: new URL(url).pathname,
				model: String(body.model ?? ""),
			});
			if (postCalls.length === 1) {
				throw new Error("socket hang up");
			}
			return Response.json({
				choices: [{ message: { content: "OK" } }],
			});
		});
		globalThis.fetch = fetchMock as typeof fetch;
		vi.spyOn(Math, "random").mockReturnValue(0);

		const result = await verifySiteChannel({
			channel: createOpenAiChannel(["gpt-4.1"]),
			tokens: [{ api_key: "sk-test", models_json: null }],
		});

		expect(result.verdict).toBe("serving");
		expect(postCalls).toEqual([
			{ path: "/v1/chat/completions", model: "gpt-4.1" },
			{ path: "/v1/responses", model: "gpt-4.1" },
		]);
	});

	it("只限制尝试模型数，不限制同一模型下的自动请求格式遍历", async () => {
		const postCalls: Array<{ path: string; model: string }> = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/v1/models")) {
				return Response.json({
					data: [{ id: "gpt-4.1" }, { id: "gpt-4o-mini" }],
				});
			}
			const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
			postCalls.push({
				path: new URL(url).pathname,
				model: String(body.model ?? ""),
			});
			return new Response(
				JSON.stringify({
					error: { message: "not found" },
				}),
				{
					status: 404,
					headers: { "content-type": "application/json" },
				},
			);
		});
		globalThis.fetch = fetchMock as typeof fetch;
		vi.spyOn(Math, "random").mockReturnValue(0);

		const result = await verifySiteChannel({
			channel: createOpenAiChannel(["gpt-4.1", "gpt-4o-mini"]),
			tokens: [{ api_key: "sk-test", models_json: null }],
			runtimeSettings: {
				verification_model_limit: 1,
			},
		});

		expect(result.verdict).toBe("failed");
		expect(postCalls).toEqual([
			{ path: "/v1/chat/completions", model: "gpt-4.1" },
			{ path: "/v1/responses", model: "gpt-4.1" },
		]);
	});
});
