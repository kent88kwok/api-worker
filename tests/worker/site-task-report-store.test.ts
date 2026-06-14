import { afterEach, describe, expect, it, vi } from "vitest";
import {
	listSiteTaskReports,
	saveSiteTaskReport,
	type SiteTaskReportState,
} from "../../apps/worker/src/services/site-task-report-store";

function createSiteTaskReportDb() {
	const settings = new Map<string, string>();
	const db = {
		prepare(sql: string) {
			const execute = (params: unknown[]) => ({
				async all() {
					if (sql.startsWith("SELECT key, value FROM settings WHERE key IN")) {
						return {
							results: params
								.map((key) => String(key))
								.filter((key) => settings.has(key))
								.map((key) => ({
									key,
									value: settings.get(key) ?? "",
								})),
						};
					}
					return { results: [] };
				},
				async run() {
					if (sql.startsWith("INSERT INTO settings")) {
						settings.set(String(params[0]), String(params[1]));
					}
					return { success: true };
				},
			});
			return {
				bind(...params: unknown[]) {
					return execute(params);
				},
				all() {
					return execute([]).all();
				},
				run() {
					return execute([]).run();
				},
			};
		},
	};
	return { db, settings };
}

function buildRunningVerificationReport(updatedAt: string): SiteTaskReportState {
	return {
		kind: "verify-active",
		status: "running",
		runtime_instance_id: "runtime-old",
		runs_at: "2026-06-13T07:00:00.000Z",
		started_at: "2026-06-13T07:00:00.000Z",
		finished_at: null,
		progress: {
			total: 3,
			completed: 1,
			success: 1,
			warning: 0,
			failed: 0,
			skipped: 0,
			current_site_id: "ch_1",
			current_site_name: "站点一",
			updated_at: updatedAt,
		},
		error_message: null,
		report: {
			summary: {
				total: 3,
				serving: 1,
				degraded: 0,
				failed: 0,
				recoverable: 0,
				not_recoverable: 0,
				skipped: 0,
			},
			items: [],
			runs_at: "2026-06-13T07:00:00.000Z",
		},
	};
}

describe("site task report store", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("会把来自旧实例的运行中任务立即收口为失败", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-13T08:00:00.000Z"));
		const { db, settings } = createSiteTaskReportDb();
		settings.set(
			"site_task_report_verify_active",
			JSON.stringify(
				buildRunningVerificationReport("2026-06-13T07:59:50.000Z"),
			),
		);

		const reports = await listSiteTaskReports(db as never);

		expect(reports["verify-active"]?.status).toBe("failed");
		expect(reports["verify-active"]?.error_message).toContain("重启");
		expect(reports["verify-active"]?.finished_at).toBe("2026-06-13T08:00:00.000Z");
		expect(reports["verify-active"]?.progress.current_site_id).toBeNull();
		expect(reports["verify-active"]?.progress.current_site_name).toBeNull();
		expect(settings.get("site_task_report_verify_active")).toContain(
			'"status":"failed"',
		);
	});

	it("会保留当前实例仍在运行的任务", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-13T08:00:00.000Z"));
		const { db } = createSiteTaskReportDb();
		await saveSiteTaskReport(
			db as never,
			buildRunningVerificationReport("2026-06-13T07:59:50.000Z"),
		);

		const reports = await listSiteTaskReports(db as never);

		expect(reports["verify-active"]?.status).toBe("running");
		expect(reports["verify-active"]?.progress.current_site_name).toBe("站点一");
	});

	it("会把缺少实例标识的旧运行中任务立即收口为失败", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-13T08:00:00.000Z"));
		const { db, settings } = createSiteTaskReportDb();
		settings.set(
			"site_task_report_verify_active",
			JSON.stringify({
				...buildRunningVerificationReport("2026-06-13T07:59:50.000Z"),
				runtime_instance_id: null,
			}),
		);

		const reports = await listSiteTaskReports(db as never);

		expect(reports["verify-active"]?.status).toBe("failed");
		expect(reports["verify-active"]?.error_message).toContain("重启");
		expect(settings.get("site_task_report_verify_active")).toContain(
			'"status":"failed"',
		);
	});
});
