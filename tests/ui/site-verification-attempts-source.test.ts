import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync("apps/ui/src/App.tsx", "utf8");
const channelsViewSource = readFileSync(
	"apps/ui/src/features/ChannelsView.tsx",
	"utf8",
);

describe("site verification attempts source", () => {
	it("单站验证结果弹窗会展示尝试记录摘要和逐次尝试", () => {
		expect(appSource).toContain("尝试记录");
		expect(appSource).toContain("getVerificationAttemptSummary");
		expect(appSource).toContain("getVerificationAttempts");
		expect(appSource).toContain("第 {index + 1} 次");
	});

	it("站点任务报告会展示验证尝试记录", () => {
		expect(channelsViewSource).toContain("尝试记录");
		expect(channelsViewSource).toContain("renderVerificationAttemptDetails");
		expect(channelsViewSource).toContain("getVerificationAttemptSummary");
		expect(channelsViewSource).toContain("getVerificationAttempts");
	});

	it("站点任务报告的尝试记录会展示详细错误信息", () => {
		expect(channelsViewSource).toContain("attempt.detail_code");
		expect(channelsViewSource).toContain("attempt.detail_message");
	});

	it("检测尝试记录使用固定高度并在内容过长时内部滚动", () => {
		expect(appSource).toContain("max-h-72 space-y-2 overflow-y-auto pr-1");
		expect(channelsViewSource).toContain(
			"max-h-36 space-y-1 overflow-y-auto pr-1",
		);
	});
});
