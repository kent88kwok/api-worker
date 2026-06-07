import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runCheckinAllViaWorkerMock = vi.fn();
const getCheckinScheduleTimeMock = vi.fn();
const getChannelRefreshEnabledMock = vi.fn();
const getChannelRefreshScheduleTimeMock = vi.fn();
const getChannelRecoveryProbeEnabledMock = vi.fn();
const getChannelRecoveryProbeScheduleTimeMock = vi.fn();
const getBackupScheduleEnabledMock = vi.fn();
const getBackupScheduleTimeMock = vi.fn();
const getPricingSettingsMock = vi.fn();

vi.mock("../../apps/worker/src/services/site-task-dispatcher", () => ({
	runCheckinAllViaWorker: runCheckinAllViaWorkerMock,
	refreshActiveChannelsViaWorker: vi.fn(),
	recoverDisabledChannelsViaWorker: vi.fn(),
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
	buildVerificationBatchResult: vi.fn(),
}));

vi.mock("../../apps/worker/src/services/site-task-report-store", () => ({
	saveSiteTaskReport: vi.fn(),
}));

describe("CheckinScheduler", () => {
	beforeEach(() => {
		vi.clearAllMocks();
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
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("定时任务抛错时仍会重挂下一次 alarm", async () => {
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

		await expect(scheduler.alarm()).rejects.toThrow("checkin_failed");
		expect(setAlarm).toHaveBeenCalledTimes(1);
	});
});
