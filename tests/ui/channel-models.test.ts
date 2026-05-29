import { describe, expect, it } from "vitest";
import {
	getChannelModelRows,
	getPagedChannelModelRows,
} from "../../apps/ui/src/features/channel-models";

describe("channel model rows", () => {
	it("只返回当前渠道的模型状态", () => {
		const rows = getChannelModelRows(
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
				{
					id: "gemini-pro",
					channels: [
						{ id: "channel-b", name: "渠道 B", status: "enabled" },
					],
				},
			],
			"channel-a",
		);

		expect(rows).toEqual([
			{ model: "gpt-4.1", status: "enabled" },
			{ model: "claude-sonnet", status: "pending" },
		]);
	});

	it("按正式、待加入、排除排序", () => {
		const rows = getChannelModelRows(
			[
				{
					id: "z-excluded",
					channels: [
						{ id: "channel-a", name: "渠道 A", status: "excluded" },
					],
				},
				{
					id: "b-enabled",
					channels: [
						{ id: "channel-a", name: "渠道 A", status: "enabled" },
					],
				},
				{
					id: "a-enabled",
					channels: [
						{ id: "channel-a", name: "渠道 A", status: "enabled" },
					],
				},
				{
					id: "m-pending",
					channels: [
						{ id: "channel-a", name: "渠道 A", status: "pending" },
					],
				},
			],
			"channel-a",
		);

		expect(rows).toEqual([
			{ model: "a-enabled", status: "enabled" },
			{ model: "b-enabled", status: "enabled" },
			{ model: "m-pending", status: "pending" },
			{ model: "z-excluded", status: "excluded" },
		]);
	});

	it("按关键词和状态筛选后分页展示", () => {
		const rows = Array.from({ length: 16 }, (_, index) => ({
			model: `model-${String(index + 1).padStart(2, "0")}`,
			status: index % 2 === 0 ? ("enabled" as const) : ("pending" as const),
		}));

		const result = getPagedChannelModelRows(rows, {
			page: 2,
			pageSize: 3,
			search: "model-",
			status: "enabled",
		});

		expect(result.total).toBe(8);
		expect(result.totalPages).toBe(3);
		expect(result.page).toBe(2);
		expect(result.rows.map((row) => row.model)).toEqual([
			"model-07",
			"model-09",
			"model-11",
		]);
	});
});
