import { describe, expect, it } from "vitest";
import {
	buildStopPlan,
	buildDevHealthTargets,
	classifyBackgroundDevState,
	deriveDevPorts,
	formatBackgroundStatus,
	resolveChildExitSupervisorAction,
	shouldRestartUnhealthyService,
	summarizeHealthChecks,
	waitForChildExit,
} from "../../scripts/dev-shared.mjs";

describe("dev health helpers", () => {
	it("builds only the worker health target when attempt worker is skipped", () => {
		const targets = buildDevHealthTargets({
			workerPort: 8787,
			attemptWorkerPort: 8788,
			skipAttemptWorker: true,
		});

		expect(targets).toEqual([
			{
				name: "worker",
				commandName: "worker",
				url: "http://127.0.0.1:8787/health",
			},
		]);
	});

	it("derives worker, attempt-worker, ui, and inspector ports from DEV_PORT", () => {
		const ports = deriveDevPorts({ basePort: 8787 });

		expect(ports).toEqual({
			workerPort: 8787,
			attemptWorkerPort: 8788,
			uiPort: 8789,
			workerInspectorPort: 9787,
			attemptInspectorPort: 9788,
		});
	});

	it("summarizes a live parent with a dead worker as unhealthy", () => {
		const summary = summarizeHealthChecks([
			{
				name: "worker",
				url: "http://127.0.0.1:8787/health",
				ok: false,
				error: "connect ECONNREFUSED",
			},
		]);

		expect(summary.healthy).toBe(false);
		expect(summary.level).toBe("warn");
		expect(summary.message).toContain("服务健康检查异常");
	});

	it("classifies a live parent with failing health as degraded instead of healthy", () => {
		const state = classifyBackgroundDevState({
			pidRunning: true,
			healthSummary: {
				healthy: false,
			},
		});

		expect(state.level).toBe("warn");
		expect(state.state).toBe("degraded");
		expect(state.message).toContain("父进程运行中");
	});

	it("classifies residual ports without a live parent as residual instead of stopped", () => {
		const state = classifyBackgroundDevState({
			pidRunning: false,
			healthSummary: null,
			hasResidualPorts: true,
		});

		expect(state.level).toBe("warn");
		expect(state.state).toBe("residual");
		expect(state.message).toContain("残留");
	});

	it("formats residual background status without reporting it as fully stopped", () => {
		const status = formatBackgroundStatus({
			state: null,
			healthChecks: [],
			residualPorts: [{ port: 8787, pid: 1234, commandLine: null }],
			backgroundStatus: {
				level: "warn",
				state: "residual",
				message: "后台 dev 守护进程未运行，但检测到残留实例",
			},
		});

		expect(status.summary).toContain("残留");
		expect(status.summary).not.toContain("未运行。");
	});

	it("collects managed residual pids for stop when daemon state is missing", () => {
		const plan = buildStopPlan({
			liveState: null,
			residualPorts: [
				{ port: 8787, pid: 1234, commandLine: "wrangler dev", managed: true },
				{ port: 8788, pid: 5678, commandLine: "wrangler dev", managed: true },
			],
		});

		expect(plan.kind).toBe("residual");
		expect(plan.pids).toEqual([1234, 5678]);
		expect(plan.unmanagedPorts).toEqual([]);
	});

	it("keeps unmanaged residual ports out of the stop pid list", () => {
		const plan = buildStopPlan({
			liveState: null,
			residualPorts: [
				{
					port: 8787,
					pid: 1234,
					commandLine: "python -m http.server",
					managed: false,
				},
			],
		});

		expect(plan.kind).toBe("residual");
		expect(plan.pids).toEqual([]);
		expect(plan.unmanagedPorts).toEqual([8787]);
	});

	it("restarts after grace, failure threshold, and cooldown all allow it", () => {
		const base = {
			now: 70_000,
			startedAt: 0,
			startupGraceMs: 30_000,
			restartThreshold: 3,
			restartCooldownMs: 60_000,
		};

		expect(
			shouldRestartUnhealthyService({
				...base,
				consecutiveFailures: 2,
				lastRestartAt: null,
			}),
		).toBe(false);
		expect(
			shouldRestartUnhealthyService({
				...base,
				consecutiveFailures: 3,
				lastRestartAt: null,
			}),
		).toBe(true);
		expect(
			shouldRestartUnhealthyService({
				...base,
				now: 20_000,
				consecutiveFailures: 3,
				lastRestartAt: null,
			}),
		).toBe(false);
		expect(
			shouldRestartUnhealthyService({
				...base,
				consecutiveFailures: 3,
				lastRestartAt: 30_000,
			}),
		).toBe(false);
	});

	it("waits for a child exit event before restarting the command", async () => {
		const listeners = new Map<string, () => void>();
		const child = {
			exitCode: null,
			killed: false,
			off(eventName: string, listener: () => void) {
				if (listeners.get(eventName) === listener) {
					listeners.delete(eventName);
				}
			},
			once(eventName: string, listener: () => void) {
				listeners.set(eventName, listener);
			},
		};

		const wait = waitForChildExit(child, 100);
		listeners.get("exit")?.();

		await expect(wait).resolves.toBeUndefined();
	});

	it("ignores a child exit while watchdog is intentionally restarting it", () => {
		const action = resolveChildExitSupervisorAction({
			shuttingDown: false,
			restarting: true,
			isCurrentChild: true,
			code: null,
			allChildrenExited: true,
		});

		expect(action).toEqual({ type: "ignore" });
	});
});
