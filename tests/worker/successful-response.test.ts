import { describe, expect, it } from "vitest";
import { inspectSuccessfulResponse } from "../../apps/worker/src/services/successful-response";

describe("successful response inspection", () => {
	it("要求 API 响应结构时把 200 纯文本判为异常成功响应", async () => {
		const response = new Response("temporarily offline", {
			status: 200,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});

		const inspection = await inspectSuccessfulResponse(response, {
			expectedProvider: "openai",
		});

		expect(inspection.ok).toBe(false);
		expect(inspection.code).toBe("non_api_success_response");
	});

	it("把正常 OpenAI 探针 JSON 判为通过", async () => {
		const response = Response.json({
			choices: [{ message: { content: "OK" } }],
		});

		const inspection = await inspectSuccessfulResponse(response, {
			expectedProvider: "openai",
		});

		expect(inspection.ok).toBe(true);
		expect(inspection.outputText).toBe("OK");
	});

	it("把正常 Anthropic 探针 JSON 判为通过", async () => {
		const response = Response.json({
			content: [{ type: "text", text: "OK" }],
		});

		const inspection = await inspectSuccessfulResponse(response, {
			expectedProvider: "anthropic",
		});

		expect(inspection.ok).toBe(true);
		expect(inspection.outputText).toBe("OK");
	});

	it("把正常 Gemini 探针 JSON 判为通过", async () => {
		const response = Response.json({
			candidates: [{ content: { parts: [{ text: "OK" }] } }],
		});

		const inspection = await inspectSuccessfulResponse(response, {
			expectedProvider: "gemini",
		});

		expect(inspection.ok).toBe(true);
		expect(inspection.outputText).toBe("OK");
	});

	it("把带有 error:null 的 OpenAI Responses 成功响应判为通过", async () => {
		const response = Response.json({
			id: "resp_123",
			object: "response",
			status: "completed",
			error: null,
			output: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "pong" }],
				},
			],
		});

		const inspection = await inspectSuccessfulResponse(response, {
			expectedProvider: "openai",
		});

		expect(inspection.ok).toBe(true);
		expect(inspection.outputText).toBe("pong");
	});
});
