import { afterEach, describe, expect, it, vi } from "vitest";

const providerTransformMocks = vi.hoisted(() => ({
	normalizeChatRequestMock: vi.fn(
		(
			_provider: string,
			endpoint: string,
			body: Record<string, unknown> | null,
		) => {
			if (endpoint === "responses" && body?.input === undefined) {
				return null;
			}
			return { messages: [], stream: false };
		},
	),
}));

vi.mock("../../apps/worker/src/services/provider-transform", () => ({
	normalizeChatRequest: providerTransformMocks.normalizeChatRequestMock,
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

import { persistSiteVerificationResult, verifySiteChannel } from "../../apps/worker/src/services/site-verification";

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
	providerTransformMocks.normalizeChatRequestMock.mockClear();
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
			{ path: "/v1/responses", model: "gpt-4.1" },
			{ path: "/v1/chat/completions", model: "gpt-4.1" },
		]);
	});

	it("自动模式优先命中 responses 时，会按 responses 端点标准化验证请求", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/v1/models")) {
				return Response.json({
					data: [{ id: "gpt-4.1" }],
				});
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
		expect(providerTransformMocks.normalizeChatRequestMock).toHaveBeenCalledWith(
			"openai",
			"responses",
			expect.objectContaining({
				model: "gpt-4.1",
				input: "Reply with OK.",
				max_output_tokens: 8,
			}),
			"gpt-4.1",
			false,
		);
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
			{ path: "/v1/responses", model: "gpt-4.1" },
			{ path: "/v1/chat/completions", model: "gpt-4.1" },
		]);
	});

	it("验证成功后不会把自动请求格式持久化到站点元数据", async () => {
		const calls: Array<{ sql: string; bindings: unknown[] }> = [];
		const db = {
			prepare(sql: string) {
				return {
					bind(...bindings: unknown[]) {
						calls.push({ sql, bindings });
						return {
							async first() {
								return { status: "active" };
							},
							async all() {
								return { results: [] };
							},
							async run() {
								return {};
							},
						};
					},
				};
			},
			async batch() {
				return [];
			},
		};

		await persistSiteVerificationResult({
			db: db as never,
			channel: createOpenAiChannel(["gpt-4.1"]) as never,
			tokens: [],
			result: {
				site_id: "ch_test",
				site_name: "test-openai",
				mode: "service",
				verdict: "serving",
				message: "ok",
				suggested_action: "none",
				stages: {
					connectivity: { status: "pass", code: "reachable", message: "ok" },
					capability: { status: "pass", code: "models_listed", message: "ok" },
					service: {
						status: "pass",
						code: "service_request_succeeded",
						message: "ok",
					},
					recovery: { status: "skip", code: "not_disabled", message: "ok" },
				},
				selected_model: "gpt-4.1",
				selected_token: null,
				discovered_models: [],
				token_results: [],
				token_summary: null,
				trace: {
					latency_ms: 12,
					upstream_status: 200,
				},
				checked_at: "2026-06-05T00:00:00.000Z",
			} as never,
		});

		const metadataUpdate = calls.find((call) =>
			call.sql.includes("UPDATE channels SET metadata_json"),
		);
		expect(metadataUpdate).toBeTruthy();
		const metadata = JSON.parse(String(metadataUpdate?.bindings[0] ?? "{}"));
		expect(metadata.request_entry).toEqual({
			path: null,
			format: null,
		});
	});
});
