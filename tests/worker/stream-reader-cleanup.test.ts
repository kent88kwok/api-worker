import { describe, expect, it, vi } from "vitest";

vi.mock("../../apps/worker/src/wasm/core", () => ({
	normalizeUsageViaWasm: vi.fn(() => null),
	parseUsageFromJsonViaWasm: vi.fn(() => null),
	parseUsageFromSseLineViaWasm: vi.fn(() => null),
}));

import { extractOpenAiResponseIdFromSse } from "../../apps/worker/src/services/proxy/response-helpers";
import { detectAbnormalStreamSuccessResponse } from "../../apps/worker/src/services/proxy/usage-observe";
import { parseUsageFromSse } from "../../apps/worker/src/utils/usage";

type TrackedReaderState = {
	cancelCalls: number;
	releaseCalls: number;
};

function createTrackedResponse(
	chunks: string[],
	headers: Record<string, string> = {
		"content-type": "text/event-stream",
	},
) {
	const encoder = new TextEncoder();
	const state: TrackedReaderState = {
		cancelCalls: 0,
		releaseCalls: 0,
	};
	const queue = chunks.map((chunk) => encoder.encode(chunk));
	const reader = {
		read: vi.fn(async () => {
			if (queue.length === 0) {
				return {
					done: true,
					value: undefined,
				};
			}
			return {
				done: false,
				value: queue.shift(),
			};
		}),
		cancel: vi.fn(async () => {
			state.cancelCalls += 1;
		}),
		releaseLock: vi.fn(() => {
			state.releaseCalls += 1;
		}),
	};
	const response = {
		headers: new Headers(headers),
		body: {
			getReader: () => reader,
		},
		clone() {
			return response;
		},
	} as unknown as Response;

	return {
		response,
		state,
	};
}

describe("stream reader cleanup", () => {
	it("parseUsageFromSse 在异常成功提前返回时也会清理 reader", async () => {
		const { response, state } = createTrackedResponse([
			'data: {"type":"response.failed","message":"boom"}\n\n',
		]);

		const result = await parseUsageFromSse(response, {
			mode: "full",
			timeoutMs: 1000,
		});

		expect(result.abnormal?.errorCode).toBe("upstream_stream_error_payload");
		expect(state.cancelCalls).toBeGreaterThan(0);
		expect(state.releaseCalls).toBeGreaterThan(0);
	});

	it("detectAbnormalStreamSuccessResponse 在提前命中异常时会释放 reader", async () => {
		const { response, state } = createTrackedResponse([
			'data: {"type":"response.failed","message":"boom"}\n\n',
		]);

		const result = await detectAbnormalStreamSuccessResponse(response);

		expect(result?.errorCode).toBe("upstream_stream_error_payload");
		expect(state.cancelCalls).toBeGreaterThan(0);
		expect(state.releaseCalls).toBeGreaterThan(0);
	});

	it("extractOpenAiResponseIdFromSse 即使未命中 response id 也会清理 reader", async () => {
		const { response, state } = createTrackedResponse([
			'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
		]);

		const result = await extractOpenAiResponseIdFromSse(response, 64 * 1024, 5);

		expect(result).toBeNull();
		expect(state.cancelCalls).toBeGreaterThan(0);
		expect(state.releaseCalls).toBeGreaterThan(0);
	});
});
