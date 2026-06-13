#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { buildBackgroundStateFromArgs } from "./autostart-shared.mjs";
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
} from "./dev-shared.mjs";

const BUN_CMD = (() => {
	if (process.env.BUN_BIN && existsSync(process.env.BUN_BIN)) {
		return process.env.BUN_BIN;
	}
	const npmExec = process.env.npm_execpath;
	if (npmExec && existsSync(npmExec)) {
		const npmExecBaseName = path.basename(npmExec).toLowerCase();
		if (npmExecBaseName === "bun" || npmExecBaseName === "bun.exe") {
			return npmExec;
		}
	}
	if (process.env.BUN_INSTALL) {
		const candidate = path.join(
			process.env.BUN_INSTALL,
			"bin",
			process.platform === "win32" ? "bun.exe" : "bun",
		);
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return process.platform === "win32" ? "bun.exe" : "bun";
})();

const scriptPath = fileURLToPath(import.meta.url);
const stateDir = path.join(process.cwd(), ".dev");
const statePath = path.join(stateDir, "dev-runner.json");
const logPath = path.join(stateDir, "dev-runner.log");
const generatedWranglerRoot = path.join(stateDir, "generated", "wrangler");
const workerAppDir = path.join(process.cwd(), "apps/worker");
const attemptWorkerAppDir = path.join(process.cwd(), "apps/attempt-worker");
const nullDevicePath =
	process.platform === "win32" ? "\\\\.\\NUL" : "/dev/null";

const rawArgs = process.argv.slice(2);
const interactiveDelegatedMode = rawArgs.includes("--_interactive-run");
const runtimeArgs = rawArgs.filter((arg) => arg !== "--_interactive-run");
const daemonMode = runtimeArgs.includes("--_daemon");
const backgroundMode = runtimeArgs.includes("--bg");
const statusMode = runtimeArgs.includes("--status");
const stopMode = runtimeArgs.includes("--stop");

const parseOptionValue = (args, flag, defaultValue) => {
	let value = defaultValue;
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] !== flag) {
			continue;
		}
		const nextValue = args[index + 1];
		if (!nextValue || nextValue.startsWith("--")) {
			throw new Error(`${flag} 需要提供参数值`);
		}
		value = nextValue.trim();
		index += 1;
	}
	return value;
};

const logMode = parseOptionValue(runtimeArgs, "--log-mode", "file");
if (!["file", "none"].includes(logMode)) {
	throw new Error("--log-mode 仅支持 file / none");
}
const shouldHideBackgroundWindows = process.platform === "win32" && daemonMode;
const backgroundOutputPath = daemonMode
	? logMode === "none"
		? nullDevicePath
		: logPath
	: null;

const useRemoteWorker = runtimeArgs.includes("--remote-worker");
const useRemoteD1 = runtimeArgs.includes("--remote-d1") || useRemoteWorker;
const disableHotCache = runtimeArgs.includes("--no-hot-cache");
const skipAttemptWorker = runtimeArgs.includes("--no-attempt-worker");
const skipUi = runtimeArgs.includes("--no-ui");
const buildUi = runtimeArgs.includes("--build-ui");
const skipUiBuild = runtimeArgs.includes("--skip-ui-build");
const isInteractiveTerminal = Boolean(
	process.stdin.isTTY && process.stdout.isTTY,
);

const devInteractiveBaseOptions = [
	{ flag: "--no-attempt-worker", label: "不启动调用执行器 attempt-worker" },
	{ flag: "--no-ui", label: "不启动 UI dev server" },
	{ flag: "--no-hot-cache", label: "禁用热缓存 KV_HOT" },
	{ flag: "--remote-d1", label: "连接云端 D1/KV" },
	{ flag: "--remote-worker", label: "主 worker / attempt-worker 都走远端预览" },
];

const devInteractiveUiBuildOptions = [
	{ mode: "1", label: "构建 UI（--build-ui）", flags: ["--build-ui"] },
	{
		mode: "2",
		label: "跳过 UI 预构建（--skip-ui-build）",
		flags: ["--skip-ui-build"],
	},
];

const backgroundLogModeOptions = [
	{ mode: "1", label: "写入日志文件（默认）", flags: [] },
	{
		mode: "2",
		label: "关闭后台日志（--log-mode none）",
		flags: ["--log-mode", "none"],
	},
];

const parsePortFromEnv = (name, fallback) => {
	const raw = process.env[name];
	if (!raw || raw.trim().length === 0) {
		return fallback;
	}
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		throw new Error(
			`环境变量 ${name} 端口非法（${raw}），需为 1-65535 的整数。`,
		);
	}
	return value;
};

const basePort = parsePortFromEnv("DEV_PORT", 8787);
const {
	workerPort,
	attemptWorkerPort,
	uiPort,
	workerInspectorPort,
	attemptInspectorPort,
} = deriveDevPorts({ basePort });

const devServicePortDefinitions = [
	{ name: "worker", port: workerPort, skipFlag: null },
	{
		name: "attempt-worker",
		port: attemptWorkerPort,
		skipFlag: "--no-attempt-worker",
	},
	{ name: "ui", port: uiPort, skipFlag: "--no-ui" },
];

const normalizeMatchText = (value) =>
	process.platform === "win32"
		? String(value ?? "").toLowerCase()
		: String(value ?? "");

const managedCommandMarkers = [
	process.cwd(),
	scriptPath,
	generatedWranglerRoot,
	workerAppDir,
	attemptWorkerAppDir,
	path.join(process.cwd(), "apps", "ui"),
	"api-worker-ui",
].map((item) => normalizeMatchText(item));

const collectServicePortsForArgs = (args, includeAll = false) =>
	devServicePortDefinitions
		.filter(
			(definition) =>
				includeAll ||
				!definition.skipFlag ||
				!(args ?? []).includes(definition.skipFlag),
		)
		.map((definition) => definition.port);

const parsePortFromEndpoint = (endpoint) => {
	const match = String(endpoint ?? "").match(/:(\d+)$/u);
	if (!match) {
		return null;
	}
	const port = Number(match[1]);
	return Number.isInteger(port) ? port : null;
};

const summarizeCommandLine = (commandLine) => {
	const text = String(commandLine ?? "").trim();
	if (text.length <= 160) {
		return text;
	}
	return `${text.slice(0, 157)}...`;
};

const getProcessCommandLine = (pid) => {
	if (!Number.isInteger(pid)) {
		return null;
	}
	if (process.platform === "win32") {
		const psScript = `$ErrorActionPreference='SilentlyContinue'; $p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { $p.CommandLine }`;
		const result = spawnSync(
			"powershell.exe",
			["-NoProfile", "-Command", psScript],
			{ encoding: "utf8" },
		);
		if (result.status !== 0) {
			return null;
		}
		const output = result.stdout.trim();
		return output.length > 0 ? output : null;
	}
	const result = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
		encoding: "utf8",
	});
	if (result.status !== 0) {
		return null;
	}
	const output = result.stdout.trim();
	return output.length > 0 ? output : null;
};

const parseWindowsPortListeners = (ports) => {
	const portSet = new Set(ports);
	const result = spawnSync("netstat", ["-ano", "-p", "tcp"], {
		encoding: "utf8",
	});
	if (result.status !== 0) {
		return [];
	}
	const listeners = new Map();
	for (const line of result.stdout.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("TCP")) {
			continue;
		}
		const columns = trimmed.split(/\s+/u);
		if (columns.length < 5 || columns[3] !== "LISTENING") {
			continue;
		}
		const port = parsePortFromEndpoint(columns[1]);
		if (port === null || !portSet.has(port)) {
			continue;
		}
		const pid = Number(columns[4]);
		if (!Number.isInteger(pid)) {
			continue;
		}
		listeners.set(`${port}:${pid}`, { port, pid });
	}
	return Array.from(listeners.values());
};

const parseUnixPortListenersFromLsof = (ports) => {
	const portSet = new Set(ports);
	const result = spawnSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
		encoding: "utf8",
	});
	if (result.error || result.status !== 0) {
		return null;
	}
	const listeners = new Map();
	for (const line of result.stdout.split(/\r?\n/u).slice(1)) {
		const match = line.match(
			/^\S+\s+(\d+)\s+\S+.*TCP\s+.+:(\d+)\s+\(LISTEN\)$/u,
		);
		if (!match) {
			continue;
		}
		const pid = Number(match[1]);
		const port = Number(match[2]);
		if (!Number.isInteger(pid) || !portSet.has(port)) {
			continue;
		}
		listeners.set(`${port}:${pid}`, { port, pid });
	}
	return Array.from(listeners.values());
};

const parseUnixPortListenersFromSs = (ports) => {
	const portSet = new Set(ports);
	const result = spawnSync("ss", ["-ltnp"], { encoding: "utf8" });
	if (result.error || result.status !== 0) {
		return [];
	}
	const listeners = new Map();
	for (const line of result.stdout.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("LISTEN")) {
			continue;
		}
		const portMatch = trimmed.match(/:(\d+)\s+/u);
		if (!portMatch) {
			continue;
		}
		const port = Number(portMatch[1]);
		if (!portSet.has(port)) {
			continue;
		}
		const pidMatch = trimmed.match(/pid=(\d+)/u);
		const pid = pidMatch ? Number(pidMatch[1]) : null;
		listeners.set(`${port}:${pid ?? "unknown"}`, { port, pid });
	}
	return Array.from(listeners.values());
};

const readPortListeners = (ports) =>
	process.platform === "win32"
		? parseWindowsPortListeners(ports)
		: (parseUnixPortListenersFromLsof(ports) ??
			parseUnixPortListenersFromSs(ports));

const isManagedDevPortProcess = ({ port, commandLine }) => {
	const normalized = normalizeMatchText(commandLine);
	if (!normalized) {
		return false;
	}
	if (managedCommandMarkers.some((marker) => normalized.includes(marker))) {
		return true;
	}
	if (port === uiPort) {
		return normalized.includes("api-worker-ui") || normalized.includes("vite");
	}
	return normalized.includes("wrangler") && normalized.includes("dev");
};

const detectResidualDevPorts = ({ ports }) =>
	readPortListeners(ports).map(({ port, pid }) => {
		const commandLine =
			typeof pid === "number" ? getProcessCommandLine(pid) : null;
		return {
			port,
			pid: typeof pid === "number" ? pid : null,
			commandLine,
			managed: isManagedDevPortProcess({ port, commandLine }),
		};
	});

const printResidualPortDetails = (residualPorts) => {
	for (const residual of residualPorts) {
		const scope =
			residual.managed === false ? "非本项目进程占用" : "疑似本项目残留实例";
		const pidText =
			typeof residual.pid === "number" ? `PID ${residual.pid}` : "PID 未知";
		const commandText = residual.commandLine
			? `；命令: ${summarizeCommandLine(residual.commandLine)}`
			: "";
		console.log(
			`⚠️ 端口 ${residual.port}: ${pidText}（${scope}${commandText}）`,
		);
	}
};

const assertPortsAvailableForArgs = (args) => {
	const ports = collectServicePortsForArgs(args, false);
	const occupied = detectResidualDevPorts({ ports });
	if (occupied.length === 0) {
		return;
	}
	const portSummary = occupied
		.map((item) => `${item.port}${item.managed === false ? " (外部占用)" : ""}`)
		.join(", ");
	const recoveryHint = occupied.some((item) => item.managed !== false)
		? "可先执行 bun run dev -- --stop 清理残留实例；"
		: "";
	throw new Error(
		`开发端口已被占用：${portSummary}。${recoveryHint}若为外部进程，请手动释放端口后重试。`,
	);
};

const stopManagedResidualPorts = async (residualPorts) => {
	const stopPlan = buildStopPlan({
		liveState: null,
		residualPorts,
	});
	for (const pid of stopPlan.pids) {
		await killTree(pid);
	}
	return stopPlan;
};

const children = new Map();
const commandDefinitions = new Map();
const healthFailures = new Map();
const healthRestartTimes = new Map();
const restartingCommands = new Set();
let shuttingDown = false;

const healthCheckIntervalMs = Number(
	process.env.DEV_HEALTH_CHECK_INTERVAL_MS ?? 10_000,
);
const healthCheckTimeoutMs = Number(
	process.env.DEV_HEALTH_CHECK_TIMEOUT_MS ?? 3_000,
);
const healthRestartStopTimeoutMs = Number(
	process.env.DEV_HEALTH_RESTART_STOP_TIMEOUT_MS ?? 5_000,
);
const healthStartupGraceMs = Number(
	process.env.DEV_HEALTH_STARTUP_GRACE_MS ?? 30_000,
);
const healthRestartThreshold = Number(
	process.env.DEV_HEALTH_RESTART_THRESHOLD ?? 3,
);
const healthRestartCooldownMs = Number(
	process.env.DEV_HEALTH_RESTART_COOLDOWN_MS ?? 60_000,
);

const printSync = (message) => {
	writeSync(1, `${message}\n`);
};

const parseInteractiveSelection = (raw, maxIndex) => {
	const text = String(raw ?? "").trim();
	if (text.length === 0) {
		return [];
	}
	const parts = text
		.split(/[\s,，、]+/u)
		.map((item) => item.trim())
		.filter(Boolean);
	const indexes = [];
	for (const part of parts) {
		const value = Number(part);
		if (!Number.isInteger(value) || value < 1 || value > maxIndex) {
			throw new Error(
				`无效编号 "${part}"，请输入 1-${maxIndex} 之间的数字，可用空格分隔。`,
			);
		}
		if (!indexes.includes(value)) {
			indexes.push(value);
		}
	}
	return indexes;
};

const parseUiBuildModeArgs = (selection) => {
	const mode = String(selection ?? "").trim();
	if (mode.length === 0) {
		return ["--skip-ui-build"];
	}
	const matched = devInteractiveUiBuildOptions.find(
		(item) => item.mode === mode,
	);
	if (!matched) {
		throw new Error("UI 预构建策略无效，请输入 1 / 2。");
	}
	return matched.flags;
};

const parseBackgroundLogModeArgs = (selection) => {
	const mode = String(selection ?? "").trim();
	if (mode.length === 0) {
		return [];
	}
	const matched = backgroundLogModeOptions.find((item) => item.mode === mode);
	if (!matched) {
		throw new Error("后台日志策略无效，请输入 1 / 2。");
	}
	return matched.flags;
};

const promptInteractiveRunArgs = async () => {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		while (true) {
			console.log("交互模式：开发服务");
			console.log("1. 开始");
			console.log("2. 查看后台状态");
			console.log("3. 停止后台实例");
			console.log("0. 退出");
			const action = (await rl.question("请选择操作编号: ")).trim();
			if (action === "0") {
				return null;
			}
			if (action === "2") {
				return ["--status"];
			}
			if (action === "3") {
				return ["--stop"];
			}
			if (action === "1") {
				console.log("");
				console.log("开始开发服务：请选择附加参数（可多选）");
				for (let i = 0; i < devInteractiveBaseOptions.length; i += 1) {
					const option = devInteractiveBaseOptions[i];
					console.log(`${i + 1}. ${option.label}: ${option.flag}`);
				}
				const selection = await rl.question(
					"输入编号（示例: 1 4；直接回车=不附加参数）: ",
				);
				const selectedIndexes = parseInteractiveSelection(
					selection,
					devInteractiveBaseOptions.length,
				);
				const args = selectedIndexes.map(
					(index) => devInteractiveBaseOptions[index - 1].flag,
				);
				console.log("");
				console.log("UI 预构建策略（单选）:");
				for (const option of devInteractiveUiBuildOptions) {
					console.log(`${option.mode}. ${option.label}`);
				}
				const uiBuildMode = await rl.question(
					"请选择 UI 预构建策略（默认 2）: ",
				);
				args.push(...parseUiBuildModeArgs(uiBuildMode));
				const runMode = (
					await rl.question("是否静默启动（1=否，2=是，默认 1）: ")
				)
					.trim()
					.toLowerCase();
				if (runMode === "2") {
					args.push("--bg");
					console.log("");
					console.log("后台日志策略（单选）:");
					for (const option of backgroundLogModeOptions) {
						console.log(`${option.mode}. ${option.label}`);
					}
					const backgroundLogMode = await rl.question(
						"请选择后台日志策略（默认 1）: ",
					);
					args.push(...parseBackgroundLogModeArgs(backgroundLogMode));
				} else if (runMode.length > 0 && runMode !== "1") {
					throw new Error("启动方式无效，请输入 1 / 2。");
				}
				return args;
			}
			console.log("输入无效，请输入 0 / 1 / 2 / 3。");
		}
	} finally {
		rl.close();
	}
};

const runSelf = (args) =>
	new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [scriptPath, ...args], {
			stdio: "inherit",
			cwd: process.cwd(),
			env: process.env,
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`交互执行失败，退出码 ${code ?? 1}`));
		});
	});

const ensureStateDir = () => {
	mkdirSync(stateDir, { recursive: true });
};

const readState = () => {
	if (!existsSync(statePath)) {
		return null;
	}
	try {
		return JSON.parse(readFileSync(statePath, "utf8"));
	} catch {
		return null;
	}
};

const removeState = (expectedPid) => {
	if (!existsSync(statePath)) {
		return;
	}
	try {
		if (typeof expectedPid === "number") {
			const state = readState();
			if (!state || state.pid !== expectedPid) {
				return;
			}
		}
		unlinkSync(statePath);
	} catch {
		// ignore stale state cleanup errors
	}
};

const isPidRunning = (pid) => {
	if (typeof pid !== "number" || Number.isNaN(pid)) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const readDetachedBackgroundState = () => {
	if (process.platform === "win32") {
		return null;
	}
	const psResult = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
	if (psResult.status !== 0) {
		return null;
	}
	for (const line of psResult.stdout.split(/\r?\n/u)) {
		const match = line.trim().match(/^(\d+)\s+(.+)$/u);
		if (!match) {
			continue;
		}
		const pid = Number(match[1]);
		if (pid === process.pid) {
			continue;
		}
		const commandLine = match[2];
		if (
			!commandLine.includes(scriptPath) ||
			!commandLine.includes("--_daemon")
		) {
			continue;
		}
		const parts = commandLine.split(/\s+/u);
		const scriptIndex = parts.findIndex((item) => item === scriptPath);
		if (scriptIndex < 0) {
			continue;
		}
		const startedAtResult = spawnSync(
			"ps",
			["-p", String(pid), "-o", "lstart="],
			{
				encoding: "utf8",
			},
		);
		return buildBackgroundStateFromArgs({
			pid,
			args: parts.slice(scriptIndex + 1),
			startedAt: startedAtResult.stdout.trim() || null,
			defaultLogPath: logPath,
		});
	}
	return null;
};

const readLiveState = () => {
	const state = readState();
	if (state) {
		if (isPidRunning(state.pid)) {
			return state;
		}
		removeState(state.pid);
	}
	return readDetachedBackgroundState();
};

const writeState = (state) => {
	ensureStateDir();
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
};

const updateStatePatch = (patch) => {
	const state = readState();
	if (!state || state.pid !== process.pid) {
		return;
	}
	writeState({
		...state,
		...patch,
	});
};

const killTree = async (pid) =>
	new Promise((resolve, reject) => {
		if (process.platform === "win32") {
			const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
			});
			child.on("error", reject);
			child.on("exit", (code) => {
				if (code === 0 || code === 128) {
					resolve();
					return;
				}
				reject(new Error(`taskkill 退出码 ${code ?? 1}`));
			});
			return;
		}
		try {
			process.kill(-pid, "SIGTERM");
			resolve();
		} catch {
			try {
				process.kill(pid, "SIGTERM");
				resolve();
			} catch (error) {
				reject(error);
			}
		}
	});

const checkHealthTarget = async (target) => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), healthCheckTimeoutMs);
	try {
		const response = await fetch(target.url, { signal: controller.signal });
		return {
			...target,
			ok: response.ok,
			status: response.status,
			error: response.ok ? null : `HTTP ${response.status}`,
		};
	} catch (error) {
		return {
			...target,
			ok: false,
			status: null,
			error: error?.message ?? String(error),
		};
	} finally {
		clearTimeout(timeout);
	}
};

const checkHealthTargets = async (targets) =>
	Promise.all(targets.map((target) => checkHealthTarget(target)));

const shutdown = (code = 0) => {
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;
	for (const child of children.values()) {
		if (!child.killed) {
			child.kill("SIGINT");
		}
	}
	if (daemonMode) {
		removeState(process.pid);
	}
	process.exit(code);
};

const createSpawnStdio = () => {
	if (!daemonMode || !backgroundOutputPath) {
		return {
			stdio: "inherit",
			close: () => {},
		};
	}
	const stdoutFd = openSync(backgroundOutputPath, "a");
	const stderrFd = openSync(backgroundOutputPath, "a");
	return {
		stdio: ["ignore", stdoutFd, stderrFd],
		close: () => {
			closeSync(stdoutFd);
			closeSync(stderrFd);
		},
	};
};

const runOnce = (command, args, name) =>
	new Promise((resolve, reject) => {
		const spawnStdio = createSpawnStdio();
		const child = spawn(command, args, {
			stdio: spawnStdio.stdio,
			windowsHide: shouldHideBackgroundWindows,
		});
		spawnStdio.close();
		child.on("error", (error) => {
			if (error.code === "ENOENT") {
				reject(
					new Error(
						"未找到 Bun，请确认已安装并配置 PATH，或设置 BUN_BIN 指向 bun 可执行文件。",
					),
				);
				return;
			}
			reject(new Error(`执行 ${name} 失败: ${error.message}`));
		});
		child.on("exit", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`执行 ${name} 失败，退出码 ${code ?? 1}`));
		});
	});

const runBunScript = (name, args) =>
	runOnce(BUN_CMD, ["run", name, ...args], name);

const prepareConfigs = async () => {
	if (useRemoteD1) {
		await runBunScript("prepare:remote-config", [
			"--",
			"--only",
			"worker",
			"--output-root",
			generatedWranglerRoot,
		]);
		if (!skipAttemptWorker) {
			await runBunScript("prepare:remote-config", [
				"--",
				"--only",
				"attempt-worker",
				"--output-root",
				generatedWranglerRoot,
			]);
		}
	}
	if (disableHotCache) {
		const baseArgs = [
			"--",
			"--output-root",
			generatedWranglerRoot,
			...(useRemoteD1 ? ["--remote"] : []),
		];
		await runBunScript("prepare:no-hot-cache-config", [
			...baseArgs,
			"--only",
			"worker",
		]);
		if (!skipAttemptWorker) {
			await runBunScript("prepare:no-hot-cache-config", [
				...baseArgs,
				"--only",
				"attempt-worker",
			]);
		}
	}
};

const prepareUiBuild = async () => {
	if (!buildUi || skipUiBuild) {
		return;
	}
	await runBunScript("build:ui", []);
};

const stripNamedBlock = (sourceText, header) => {
	const lines = sourceText.split(/\r?\n/u);
	const output = [];
	let skipping = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!skipping && trimmed === header) {
			skipping = true;
			continue;
		}
		if (skipping) {
			if (trimmed.startsWith("[")) {
				skipping = false;
				output.push(line);
			}
			continue;
		}
		output.push(line);
	}
	return `${output.join("\n").replace(/\n+$/u, "")}\n`;
};

const toTomlLiteralPath = (filePath) =>
	`'${path.resolve(filePath).replace(/'/g, "''")}'`;

const ensureD1MigrationsDir = (sourceText, migrationsDir) =>
	sourceText.replace(
		/(\[\[d1_databases\]\][\s\S]*?)(?=\r?\n\[[^\n]+\]|\r?\n\[\[[^\n]+\]\]|$)/gu,
		(block) => {
			if (/\bmigrations_dir\s*=/u.test(block)) {
				return block;
			}
			return block.replace(
				/(\bdatabase_id\s*=\s*["'][^"']*["']\s*)/u,
				`$1migrations_dir = ${migrationsDir}\n`,
			);
		},
	);

const rewriteConfigPathsForExternalOutput = (sourceText, sourceDir) => {
	const migrationsDir = toTomlLiteralPath(
		path.resolve(sourceDir, "migrations"),
	);
	const rewriteMaybeRelative = (rawPath) => {
		if (path.isAbsolute(rawPath)) {
			return toTomlLiteralPath(rawPath);
		}
		return toTomlLiteralPath(path.resolve(sourceDir, rawPath));
	};

	const rewrittenText = sourceText
		.replace(
			/(\bmain\s*=\s*)(["'])([^"']+)\2/u,
			(_, prefix, _quote, rawPath) =>
				`${prefix}${rewriteMaybeRelative(rawPath)}`,
		)
		.replace(
			/(\[assets\][\s\S]*?\bdirectory\s*=\s*)(["'])([^"']+)\2/u,
			(_, prefix, _quote, rawPath) =>
				`${prefix}${rewriteMaybeRelative(rawPath)}`,
		);

	return ensureD1MigrationsDir(rewrittenText, migrationsDir);
};

const resolveGeneratedConfigPath = (target, filename) =>
	path.join(generatedWranglerRoot, target, filename);

const ensureLocalConfigForRun = (target) => {
	const sourcePath = path.join(process.cwd(), "apps", target, "wrangler.toml");
	const sourceText = readFileSync(sourcePath, "utf8");
	const outputPath = resolveGeneratedConfigPath(target, ".wrangler.local.toml");
	const rewrittenText = rewriteConfigPathsForExternalOutput(
		sourceText,
		path.dirname(sourcePath),
	);
	mkdirSync(path.dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, rewrittenText, "utf8");
	return outputPath;
};

const resolveWorkerBaseConfig = () => {
	if (useRemoteD1) {
		return disableHotCache
			? resolveGeneratedConfigPath(
					"worker",
					".wrangler.remote.no-hot-cache.toml",
				)
			: resolveGeneratedConfigPath("worker", ".wrangler.remote.toml");
	}
	return disableHotCache
		? resolveGeneratedConfigPath("worker", ".wrangler.local.no-hot-cache.toml")
		: ensureLocalConfigForRun("worker");
};

const ensureWorkerConfigForRun = () => {
	const baseConfig = resolveWorkerBaseConfig();
	if (!skipAttemptWorker) {
		return baseConfig;
	}
	const sourceText = readFileSync(baseConfig, "utf8");
	const strippedText = stripNamedBlock(sourceText, "[[services]]");
	const outputName = useRemoteD1
		? disableHotCache
			? ".wrangler.remote.no-hot-cache.no-attempt-worker.toml"
			: ".wrangler.remote.no-attempt-worker.toml"
		: disableHotCache
			? ".wrangler.local.no-hot-cache.no-attempt-worker.toml"
			: ".wrangler.local.no-attempt-worker.toml";
	const outputPath = resolveGeneratedConfigPath("worker", outputName);
	mkdirSync(path.dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, strippedText, "utf8");
	return outputPath;
};

const applyLocalWorkerMigrations = async (workerConfigPath) => {
	if (useRemoteD1) {
		return;
	}
	await runOnce(
		BUN_CMD,
		["run", "scripts/repair-local-d1.mjs", workerConfigPath],
		"repair local d1",
	);
	await runOnce(
		BUN_CMD,
		[
			"x",
			"wrangler",
			"d1",
			"migrations",
			"apply",
			"DB",
			"--local",
			"--config",
			workerConfigPath,
		],
		"worker local migrations",
	);
};

const buildCommands = (workerConfigPath) => {
	const commands = [];
	if (!skipAttemptWorker) {
		const attemptWranglerArgs = ["dev", "--port", String(attemptWorkerPort)];
		if (useRemoteD1) {
			attemptWranglerArgs.push(
				"--config",
				disableHotCache
					? resolveGeneratedConfigPath(
							"attempt-worker",
							".wrangler.remote.no-hot-cache.toml",
						)
					: resolveGeneratedConfigPath(
							"attempt-worker",
							".wrangler.remote.toml",
						),
			);
		} else if (disableHotCache) {
			attemptWranglerArgs.push(
				"--config",
				resolveGeneratedConfigPath(
					"attempt-worker",
					".wrangler.local.no-hot-cache.toml",
				),
			);
		} else {
			attemptWranglerArgs.push(
				"--config",
				ensureLocalConfigForRun("attempt-worker"),
			);
		}
		if (useRemoteWorker) {
			attemptWranglerArgs.push("--remote");
		}
		attemptWranglerArgs.push("--inspector-port", String(attemptInspectorPort));
		commands.push({
			name: "attempt-worker",
			cmd: BUN_CMD,
			args: ["x", "wrangler", ...attemptWranglerArgs],
			cwd: attemptWorkerAppDir,
		});
	}
	const workerWranglerArgs = ["dev", "--port", String(workerPort)];
	workerWranglerArgs.push("--config", workerConfigPath);
	if (useRemoteWorker) {
		workerWranglerArgs.push("--remote");
	}
	if (!skipAttemptWorker && !useRemoteWorker) {
		workerWranglerArgs.push(
			"--var",
			`LOCAL_ATTEMPT_WORKER_URL:http://127.0.0.1:${attemptWorkerPort}`,
		);
	}
	workerWranglerArgs.push("--inspector-port", String(workerInspectorPort));
	commands.push({
		name: "worker",
		cmd: BUN_CMD,
		args: ["x", "wrangler", ...workerWranglerArgs],
		cwd: path.join(process.cwd(), "apps/worker"),
	});
	if (!skipUi) {
		commands.push({
			name: "ui",
			cmd: BUN_CMD,
			args: [
				"--filter",
				"api-worker-ui",
				"dev",
				"--",
				"--port",
				String(uiPort),
			],
		});
	}
	return commands;
};

const spawnLongRunningCommand = (command) => {
	const spawnStdio = createSpawnStdio();
	const child = spawn(command.cmd, command.args, {
		stdio: spawnStdio.stdio,
		cwd: command.cwd ?? process.cwd(),
		windowsHide: shouldHideBackgroundWindows,
	});
	spawnStdio.close();
	children.set(command.name, child);
	child.on("error", (error) => {
		if (error.code === "ENOENT") {
			console.error(
				"❌ 未找到 Bun，请确认已安装并配置 PATH，或设置 BUN_BIN 指向 bun 可执行文件。",
			);
			shutdown(1);
			return;
		}
		console.error(`❌ 启动 ${command.name} 失败: ${error.message}`);
		shutdown(1);
	});
	child.on("exit", (code) => {
		const allChildrenExited = Array.from(children.values()).every(
			(item) => item.exitCode !== null,
		);
		const action = resolveChildExitSupervisorAction({
			shuttingDown,
			restarting: restartingCommands.has(command.name),
			isCurrentChild: children.get(command.name) === child,
			code,
			allChildrenExited,
		});
		if (action.type === "ignore") {
			return;
		}
		shutdown(action.code);
	});
	return child;
};

const restartLongRunningCommand = async (commandName, reason) => {
	const command = commandDefinitions.get(commandName);
	if (!command) {
		return;
	}
	const child = children.get(commandName);
	console.error(`⚠️ ${commandName} 健康检查失败，正在重启：${reason}`);
	if (child && child.exitCode === null && !child.killed) {
		restartingCommands.add(commandName);
		try {
			child.kill("SIGINT");
			await waitForChildExit(child, healthRestartStopTimeoutMs);
		} finally {
			restartingCommands.delete(commandName);
		}
	}
	spawnLongRunningCommand(command);
	const now = Date.now();
	healthFailures.set(commandName, 0);
	healthRestartTimes.set(commandName, now);
	updateStatePatch({
		lastHealthRestartAt: new Date(now).toISOString(),
		lastHealthRestartService: commandName,
		lastHealthRestartReason: reason,
	});
};

const runHealthWatchdog = async (targets, startedAt) => {
	const checks = await checkHealthTargets(targets);
	const summary = summarizeHealthChecks(checks);
	updateStatePatch({
		health: {
			healthy: summary.healthy,
			checkedAt: new Date().toISOString(),
			checks,
		},
	});
	for (const check of checks) {
		if (check.ok) {
			healthFailures.set(check.commandName, 0);
			continue;
		}
		const failures = (healthFailures.get(check.commandName) ?? 0) + 1;
		healthFailures.set(check.commandName, failures);
		const now = Date.now();
		if (
			shouldRestartUnhealthyService({
				now,
				startedAt,
				startupGraceMs: healthStartupGraceMs,
				restartThreshold: healthRestartThreshold,
				restartCooldownMs: healthRestartCooldownMs,
				consecutiveFailures: failures,
				lastRestartAt: healthRestartTimes.get(check.commandName) ?? null,
			})
		) {
			await restartLongRunningCommand(
				check.commandName,
				`${check.url} ${check.error ?? "unhealthy"}`,
			);
		}
	}
};

const startHealthWatchdog = (targets) => {
	if (!daemonMode || targets.length === 0) {
		return;
	}
	const startedAt = Date.now();
	const tick = () => {
		runHealthWatchdog(targets, startedAt).catch((error) => {
			console.error(`⚠️ 健康检查执行失败: ${error.message}`);
		});
	};
	setTimeout(tick, Math.min(healthStartupGraceMs, healthCheckIntervalMs));
	setInterval(tick, healthCheckIntervalMs);
};

const startLongRunningCommands = (commands) => {
	for (const command of commands) {
		commandDefinitions.set(command.name, command);
		spawnLongRunningCommand(command);
	}
};

const buildHealthTargetsForArgs = (args) =>
	buildDevHealthTargets({
		workerPort,
		attemptWorkerPort,
		skipAttemptWorker: args.includes("--no-attempt-worker"),
	});

const printStatus = async () => {
	const state = readLiveState();
	const statusArgs = state?.args ?? [];
	const residualPorts = detectResidualDevPorts({
		ports: collectServicePortsForArgs(statusArgs, !state),
	});
	const healthTargets = state ? buildHealthTargetsForArgs(statusArgs) : [];
	const healthChecks =
		healthTargets.length > 0 ? await checkHealthTargets(healthTargets) : [];
	const healthSummary =
		healthChecks.length > 0 ? summarizeHealthChecks(healthChecks) : null;
	const backgroundStatus = classifyBackgroundDevState({
		pidRunning: Boolean(state),
		healthSummary,
		hasResidualPorts: residualPorts.length > 0,
	});
	const { summary } = formatBackgroundStatus({
		state,
		healthChecks,
		residualPorts,
		backgroundStatus,
	});
	console.log(summary);
	if (!state && residualPorts.length === 0) {
		console.log(`默认日志文件: ${logPath}`);
		return;
	}
	if (state && healthSummary) {
		console.log(
			`${backgroundStatus.level === "warn" ? "⚠️" : "✅"} ${backgroundStatus.message}：${healthSummary.message}。`,
		);
	}
	if (!state) {
		if (residualPorts.length > 0) {
			printResidualPortDetails(residualPorts);
			console.log(`默认日志文件: ${logPath}`);
		}
		return;
	}
	console.log(`PID: ${state.pid}`);
	console.log(`启动时间: ${state.startedAt}`);
	console.log(`参数: ${state.args.join(" ") || "(无)"}`);
	console.log(`日志模式: ${state.logMode ?? "file"}`);
	console.log(`日志文件: ${state.logPath ?? "(已关闭)"}`);
	for (const check of healthChecks) {
		const checkPrefix = check.ok ? "✅" : "⚠️";
		const detail = check.ok
			? `HTTP ${check.status}`
			: (check.error ?? "unhealthy");
		console.log(`${checkPrefix} ${check.name}: ${check.url}（${detail}）`);
	}
	if (state.health?.checkedAt) {
		console.log(`最近守护检查: ${state.health.checkedAt}`);
	}
	if (state.lastHealthRestartAt) {
		console.log(
			`最近自愈重启: ${state.lastHealthRestartService ?? "unknown"} @ ${state.lastHealthRestartAt}`,
		);
		console.log(`重启原因: ${state.lastHealthRestartReason ?? "(未知)"}`);
	}
};

const stopBackground = async () => {
	const state = readLiveState();
	if (state) {
		await killTree(state.pid);
		removeState();
		console.log(`✅ 已停止后台 dev（PID ${state.pid}）。`);
		return;
	}
	const residualPorts = detectResidualDevPorts({
		ports: collectServicePortsForArgs([], true),
	});
	const stopPlan = await stopManagedResidualPorts(residualPorts);
	if (stopPlan.kind === "noop") {
		console.log("ℹ️ 后台 dev 未运行，无需停止。");
		return;
	}
	if (stopPlan.pids.length > 0) {
		console.log(`✅ 已清理残留 dev 实例（PID: ${stopPlan.pids.join(", ")}）。`);
	}
	if (stopPlan.unmanagedPorts.length > 0) {
		console.log(
			`⚠️ 以下端口仍被非本项目进程占用，未自动清理：${stopPlan.unmanagedPorts.join(", ")}`,
		);
	}
};

const startBackground = () => {
	const current = readLiveState();
	if (current) {
		printSync(`ℹ️ 后台 dev 已在运行（PID ${current.pid}）。`);
		printSync(`日志模式: ${current.logMode ?? "file"}`);
		printSync(`日志文件: ${current.logPath ?? "(已关闭)"}`);
		printSync(`查看状态: bun run dev -- --status`);
		return;
	}
	assertPortsAvailableForArgs(runtimeArgs);

	ensureStateDir();
	const cleanArgs = runtimeArgs.filter(
		(arg) => arg !== "--bg" && arg !== "--_daemon",
	);
	const outputPath = logMode === "none" ? nullDevicePath : logPath;
	const stdoutFd = openSync(outputPath, "a");
	const stderrFd = openSync(outputPath, "a");
	const child = spawn(
		process.execPath,
		[scriptPath, ...cleanArgs, "--_daemon"],
		{
			detached: true,
			stdio: ["ignore", stdoutFd, stderrFd],
			windowsHide: true,
			cwd: process.cwd(),
			env: process.env,
		},
	);
	closeSync(stdoutFd);
	closeSync(stderrFd);
	child.unref();

	writeState({
		pid: child.pid,
		args: cleanArgs,
		startedAt: new Date().toISOString(),
		logMode,
		logPath: logMode === "file" ? logPath : null,
	});
	printSync(`✅ 已后台启动 dev（PID ${child.pid}）。`);
	printSync(`日志模式: ${logMode}`);
	printSync(`日志文件: ${logMode === "file" ? logPath : "(已关闭)"}`);
	printSync(`查看状态: bun run dev -- --status`);
	printSync(`停止服务: bun run dev -- --stop`);
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("exit", () => {
	if (daemonMode) {
		removeState(process.pid);
	}
});

const main = async () => {
	if (
		!daemonMode &&
		!interactiveDelegatedMode &&
		runtimeArgs.length === 0 &&
		isInteractiveTerminal
	) {
		const interactiveArgs = await promptInteractiveRunArgs();
		if (!interactiveArgs) {
			console.log("已退出交互模式。");
			return;
		}
		await runSelf(["--_interactive-run", ...interactiveArgs]);
		return;
	}

	const actionCount = [backgroundMode, statusMode, stopMode].filter(
		Boolean,
	).length;
	if (actionCount > 1) {
		throw new Error("--bg / --status / --stop 只能三选一");
	}

	if (statusMode) {
		await printStatus();
		return;
	}

	if (stopMode) {
		await stopBackground();
		return;
	}

	if (backgroundMode && !daemonMode) {
		startBackground();
		return;
	}

	if (daemonMode) {
		writeState(
			buildBackgroundStateFromArgs({
				pid: process.pid,
				args: runtimeArgs,
				startedAt: new Date().toISOString(),
				defaultLogPath: logPath,
			}),
		);
	}

	await prepareUiBuild();
	await prepareConfigs();
	const workerConfigPath = ensureWorkerConfigForRun();
	await applyLocalWorkerMigrations(workerConfigPath);
	assertPortsAvailableForArgs(runtimeArgs);
	const commands = buildCommands(workerConfigPath);
	startLongRunningCommands(commands);
	startHealthWatchdog(
		buildDevHealthTargets({
			workerPort,
			attemptWorkerPort,
			skipAttemptWorker,
		}),
	);
};

main().catch((error) => {
	console.error(`❌ 启动前准备失败: ${error.message}`);
	process.exit(1);
});
