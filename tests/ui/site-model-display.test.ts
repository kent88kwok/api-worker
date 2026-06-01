import { describe, expect, it } from "vitest";
import {
	getModelSquareRows,
	shouldVerifyAfterSiteSubmit,
} from "../../apps/ui/src/features/site-model-display";

describe("site and model display behavior", () => {
	it("模型广场只按模型和渠道筛选，不暴露状态维度", () => {
		const rows = getModelSquareRows(
			[
				{
					id: "gpt-4.1",
					channels: [
						{ id: "channel-a", name: "渠道 A", status: "enabled" },
						{ id: "channel-b", name: "渠道 B", status: "excluded" },
					],
				},
				{
					id: "claude-sonnet",
					channels: [
						{ id: "channel-a", name: "渠道 A", status: "pending" },
					],
				},
			],
			{ channels: ["channel-a"] },
		);

		expect(rows).toEqual([
			{ model: "gpt-4.1", channels: ["渠道 A"] },
			{ model: "claude-sonnet", channels: ["渠道 A"] },
		]);
		expect(rows.some((row) => "status" in row)).toBe(false);
		expect(rows.some((row) => "counts" in row)).toBe(false);
	});

	it("站点编辑保存不自动验证，新增后才自动验证", () => {
		expect(shouldVerifyAfterSiteSubmit("edit")).toBe(false);
		expect(shouldVerifyAfterSiteSubmit("create")).toBe(true);
	});
});
