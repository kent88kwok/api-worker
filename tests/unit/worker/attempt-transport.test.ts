import { describe, expect, it, vi } from "vitest";

vi.mock("../../../apps/worker/src/domains/channel/weighted-order", () => ({
	createWeightedOrder: <T>(channels: T[]) => channels,
}));
import {
	ATTEMPT_STREAM_ERROR_CODE_HEADER,
	ATTEMPT_STREAM_ERROR_MESSAGE_HEADER,
	ATTEMPT_STREAM_ERROR_META_HEADER,
	readAttemptStreamAbnormal,
} from "../../../apps/worker/src/services/proxy/attempt-transport";

describe("attempt transport", () => {
	it("从 attempt worker 响应头保留流式错误元数据", () => {
		const headers = new Headers({
			[ATTEMPT_STREAM_ERROR_CODE_HEADER]: "upstream_stream_error_payload",
			[ATTEMPT_STREAM_ERROR_MESSAGE_HEADER]:
				"upstream_stream_error_payload: status=200",
			[ATTEMPT_STREAM_ERROR_META_HEADER]: JSON.stringify({
				type: "stream_error_payload",
				upstream_code: "response.failed",
			}),
		});

		expect(readAttemptStreamAbnormal(headers)).toMatchObject({
			errorCode: "upstream_stream_error_payload",
			errorMessage: "upstream_stream_error_payload: status=200",
			errorMetaJson: JSON.stringify({
				type: "stream_error_payload",
				upstream_code: "response.failed",
			}),
		});
	});
});
