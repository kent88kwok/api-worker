import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runCheckinAllViaWorkerMock = vi.fn();
const refreshActiveChannelsViaWorkerMock = vi.fn();
const recoverDisabledChannelsViaWorkerMock = vi.fn();
const buildVerificationBatchResultMock = vi.fn();
const getCheckinScheduleTimeMock = vi.fn();
const getChannelRefreshEnabledMock = vi.fn();
const getChannelRefreshScheduleTimeMock = vi.fn();
const getChannelRecoveryProbeEnabledMock = vi.fn();
const getChannelRecoveryProbeScheduleTimeMock = vi.fn();
const getBackupScheduleEnabledMock = vi.fn();
const getBackupScheduleTimeMock = vi.fn();
const getPricingSettingsMock = vi.fn();
const saveSiteTaskReportMock = vi.fn();

vi.mock("../../apps/worker/src/services/site-task-dispatcher", () => ({
	runCheckinAllViaWorker: runCheckinAllViaWorkerMock,
	refreshActiveChannelsViaWorker: refreshActiveChannelsViaWorkerMock,
	recoverDisabledChannelsViaWorker: recoverDisabledChannelsViaWorkerMock,
}));

vi.mock("../../apps/worker/src/services/settings", () => ({
	getCheckinScheduleTime: getCheckinScheduleTimeMock,
	getChannelRefreshEnabled: getChannelRefreshEnabledMock,
	getChannelRefreshScheduleTime: getChannelRefreshScheduleTimeMock,
	getChannelRecoveryProbeEnabled: getChannelRecoveryProbeEnabledMock,
	getChannelRecoveryProbeScheduleTime:
		getChannelRecoveryProbeScheduleTimeMock,
	getBackupScheduleEnabled: getBackupScheduleEnabledMock,
	getBackupScheduleTime: getBackupScheduleTimeMock,
	getPricingSettings: getPricingSettingsMock,
	setPricingSettings: vi.fn(),
}));

vi.mock("../../apps/worker/src/services/hot-kv", () => ({
	invalidateSelectionHotCache: vi.fn(),
}));

vi.mock("../../apps/worker/src/services/backup-sync", () => ({
	executeBackupSync: vi.fn(),
}));

vi.mock("../../apps/worker/src/services/pricing/exchange-rate", () => ({
	fetchUsdCnyRate: vi.fn(),
}));

vi.mock("../../apps/worker/src/services/pricing/sync", () => ({
	syncModelPrices: vi.fn(),
}));

vi.mock("../../apps/worker/src/services/site-verification", () => ({
	buildVerificationBatchResult: buildVerificationBatchResultMock,
}));

vi.mock("../../apps/worker/src/services/site-task-report-store", () => ({
	saveSiteTaskReport: saveSiteTaskReportMock,
}));

describe("CheckinScheduler", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-08T00:20:00+08:00"));

		runCheckinAllViaWorkerMock.mockRejectedValue(new Error("checkin_failed"));
		getCheckinScheduleTimeMock.mockResolvedValue("00:10");
		getChannelRefreshEnabledMock.mockResolvedValue(false);
		getChannelRefreshScheduleTimeMock.mockResolvedValue("02:40");
		getChannelRecoveryProbeEnabledMock.mockResolvedValue(false);
		getChannelRecoveryProbeScheduleTimeMock.mockResolvedValue("03:10");
		getBackupScheduleEnabledMock.mockResolvedValue(false);
		getBackupScheduleTimeMock.mockResolvedValue("04:20");
		getPricingSettingsMock.mockResolvedValue({
			sync_enabled: false,
			sync_schedule_time: "04:40",
		});
		recoverDisabledChannelsViaWorkerMock.mockResolvedValue({
			recovered: 0,
			items: [
				{
					verification: { site_id: "disabled-1", site_name: "禁用站点" },
				},
			],
		});
		buildVerificationBatchResultMock.mockResolvedValue({
			runs_at: "2026-06-07T19:10:00.000Z",
			summary: {
				total: 1,
				recoverable: 0,
				not_recoverable: 1,
				failed: 0,
				skipped: 0,
			},
			items: [],
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("定时任务抛错时仍会重挂下一次 alarm 且不向 alarm handler 继续抛错", async () => {
		const setAlarm = vi.fn().mockResolvedValue(undefined);
		const storage = {
			get: vi.fn().mockResolvedValue(null),
			put: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
			setAlarm,
		};
		const state = { storage };
		const env = { DB: {}, KV_HOT: undefined };

		const { CheckinScheduler } = await import(
			"../../apps/worker/src/services/checkin-scheduler"
		);
		const scheduler = new CheckinScheduler(state as never, env as never);

		await expect(scheduler.alarm()).resolves.toBeUndefined();
		expect(setAlarm).toHaveBeenCalledTimes(1);
	});

	it("签到任务异常时仍会继续执行同次到期的恢复探测", async () => {
		getChannelRecoveryProbeEnabledMock.mockResolvedValue(true);
		getChannelRecoveryProbeScheduleTimeMock.mockResolvedValue("00:10");
		const setAlarm = vi.fn().mockResolvedValue(undefined);
		const storage = {
			get: vi.fn().mockResolvedValue(null),
			put: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
			setAlarm,
		};
		const state = { storage };
		const env = { DB: {}, KV_HOT: undefined };

		const { CheckinScheduler } = await import(
			"../../apps/worker/src/services/checkin-scheduler"
		);
		const scheduler = new CheckinScheduler(state as never, env as never);

		await expect(scheduler.alarm()).resolves.toBeUndefined();
		expect(runCheckinAllViaWorkerMock).toHaveBeenCalledTimes(1);
		expect(recoverDisabledChannelsViaWorkerMock).toHaveBeenCalledTimes(1);
		expect(saveSiteTaskReportMock).toHaveBeenCalledWith(
			env.DB,
			expect.objectContaining({
				kind: "verify-disabled",
				status: "completed",
			}),
		);
		expect(setAlarm).toHaveBeenCalledTimes(1);
	});

	it("状态接口返回当前 Durable Object alarm 时间", async () => {
		const storage = {
			get: vi.fn().mockResolvedValue(null),
			getAlarm: vi.fn().mockResolvedValue(Date.parse("2026-06-08T16:10:00Z")),
		};
		const state = { storage };
		const env = { DB: {}, KV_HOT: undefined };

		const { CheckinScheduler } = await import(
			"../../apps/worker/src/services/checkin-scheduler"
		);
		const scheduler = new CheckinScheduler(state as never, env as never);

		const response = await scheduler.fetch(
			new Request("https://checkin-scheduler/status"),
		);
		const body = (await response.json()) as { current_alarm_at?: string | null };

		expect(response.status).toBe(200);
		expect(body.current_alarm_at).toBe("2026-06-08T16:10:00.000Z");
	});
});
