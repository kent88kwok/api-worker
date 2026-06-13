# Dev 单端口派生与残留实例清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `bun run dev` 的本地开发端口收敛为单一 `DEV_PORT`，并修复后台状态/停止逻辑，使其能识别并清理残留实例。

**Architecture:** 在 `scripts/dev-shared.mjs` 中提炼端口派生、后台状态分类与残留实例描述等纯逻辑，`scripts/dev.mjs` 负责接入真实进程和端口探测。通过保留守护进程健康检查、自定义残留状态以及更稳健的停止策略，实现“守护进程异常退出但端口残留”场景下的正确提示与清理。

**Tech Stack:** Node.js 脚本、Bun、Vitest、Biome、TypeScript 类型声明文件

---

### Task 1: 为单端口派生与残留状态编写失败测试

**Files:**
- Modify: `tests/scripts/dev-shared.test.ts`
- Modify: `scripts/dev-shared.d.mts`

- [ ] **Step 1: 写单端口派生的失败测试**

```ts
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
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test tests/scripts/dev-shared.test.ts`
Expected: FAIL，提示 `deriveDevPorts` 未定义或导出缺失

- [ ] **Step 3: 写残留状态分类的失败测试**

```ts
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
```

- [ ] **Step 4: 运行测试并确认失败**

Run: `bun test tests/scripts/dev-shared.test.ts`
Expected: FAIL，提示 `hasResidualPorts` 不被支持或断言不成立

- [ ] **Step 5: 提交一次小步 commit**

```bash
git add tests/scripts/dev-shared.test.ts scripts/dev-shared.d.mts
git commit -m "test: cover dev single-port derived state"
```

### Task 2: 实现端口派生与后台状态分类

**Files:**
- Modify: `scripts/dev-shared.mjs`
- Modify: `scripts/dev-shared.d.mts`
- Test: `tests/scripts/dev-shared.test.ts`

- [ ] **Step 1: 添加最小实现以通过端口派生测试**

```js
export const deriveDevPorts = ({ basePort }) => ({
	workerPort: basePort,
	attemptWorkerPort: basePort + 1,
	uiPort: basePort + 2,
	workerInspectorPort: basePort + 1000,
	attemptInspectorPort: basePort + 1001,
});
```

- [ ] **Step 2: 运行测试确认端口派生测试通过**

Run: `bun test tests/scripts/dev-shared.test.ts`
Expected: 派生端口相关断言 PASS，残留状态断言仍 FAIL

- [ ] **Step 3: 扩展后台状态分类实现**

```js
export const classifyBackgroundDevState = ({
	pidRunning,
	healthSummary,
	hasResidualPorts = false,
}) => {
	if (!pidRunning && hasResidualPorts) {
		return {
			level: "warn",
			state: "residual",
			message: "后台 dev 守护进程未运行，但检测到残留实例",
		};
	}
	if (!pidRunning) {
		return {
			level: "info",
			state: "stopped",
			message: "后台 dev 未运行",
		};
	}
	if (!healthSummary?.healthy) {
		return {
			level: "warn",
			state: "degraded",
			message: "后台 dev 父进程运行中，但服务健康检查异常",
		};
	}
	return {
		level: "success",
		state: "healthy",
		message: "后台 dev 正在运行",
	};
};
```

- [ ] **Step 4: 运行测试确认全部通过**

Run: `bun test tests/scripts/dev-shared.test.ts`
Expected: PASS

- [ ] **Step 5: 提交一次小步 commit**

```bash
git add scripts/dev-shared.mjs scripts/dev-shared.d.mts tests/scripts/dev-shared.test.ts
git commit -m "feat: add dev single-port helpers"
```

### Task 3: 为 `scripts/dev.mjs` 的残留实例识别与停止行为写失败测试

**Files:**
- Create: `tests/scripts/dev-runtime.test.ts`
- Modify: `scripts/dev-shared.d.mts`

- [ ] **Step 1: 写“状态存在残留端口时不应报未运行”的失败测试**

```ts
it("reports residual background state when no pid is live but derived ports remain occupied", async () => {
	const status = formatBackgroundStatus({
		state: null,
		healthChecks: [],
		residualPorts: [{ port: 8787, pid: 1234 }],
	});

	expect(status.summary).toContain("残留");
	expect(status.summary).not.toContain("未运行");
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `bun test tests/scripts/dev-runtime.test.ts`
Expected: FAIL，提示 `formatBackgroundStatus` 未定义

- [ ] **Step 3: 写“仅残留 PID 存在时 stop 会返回待清理 PID”的失败测试**

```ts
it("collects residual pids for stop when daemon state is missing", () => {
	const plan = buildStopPlan({
		liveState: null,
		residualPorts: [
			{ port: 8787, pid: 1234 },
			{ port: 8788, pid: 5678 },
		],
	});

	expect(plan.kind).toBe("residual");
	expect(plan.pids).toEqual([1234, 5678]);
});
```

- [ ] **Step 4: 运行测试并确认失败**

Run: `bun test tests/scripts/dev-runtime.test.ts`
Expected: FAIL，提示 `buildStopPlan` 未定义

- [ ] **Step 5: 提交一次小步 commit**

```bash
git add tests/scripts/dev-runtime.test.ts scripts/dev-shared.d.mts
git commit -m "test: cover residual dev background cleanup"
```

### Task 4: 实现 `scripts/dev.mjs` 的残留实例探测与停止逻辑

**Files:**
- Modify: `scripts/dev.mjs`
- Modify: `scripts/dev-shared.mjs`
- Modify: `scripts/dev-shared.d.mts`
- Test: `tests/scripts/dev-runtime.test.ts`

- [ ] **Step 1: 将可测试的状态格式化与停止计划提炼到 `scripts/dev-shared.mjs`**

```js
export const formatBackgroundStatus = ({
	state,
	healthChecks,
	residualPorts,
	backgroundStatus,
}) => {
	if (backgroundStatus.state === "residual") {
		const ports = residualPorts.map((item) => item.port).join(", ");
		return {
			summary: `⚠️ 后台 dev 守护进程未运行，但检测到残留端口：${ports}。`,
		};
	}
	return {
		summary: state
			? `✅ 后台 dev 正在运行：${healthChecks.length} 个健康检查目标。`
			: "ℹ️ 后台 dev 未运行。",
	};
};

export const buildStopPlan = ({ liveState, residualPorts }) => {
	if (liveState) {
		return { kind: "daemon", pids: [liveState.pid] };
	}
	const pids = Array.from(
		new Set(
			(residualPorts ?? [])
				.map((item) => item.pid)
				.filter((pid) => typeof pid === "number"),
		),
	);
	if (pids.length > 0) {
		return { kind: "residual", pids };
	}
	return { kind: "noop", pids: [] };
};
```

- [ ] **Step 2: 运行新增脚本测试确认通过**

Run: `bun test tests/scripts/dev-runtime.test.ts`
Expected: PASS

- [ ] **Step 3: 在 `scripts/dev.mjs` 接入 `DEV_PORT`、残留端口探测与停止计划**

```js
const basePort = parsePortFromEnv("DEV_PORT", 8787);
const {
	workerPort,
	attemptWorkerPort,
	uiPort,
	workerInspectorPort,
	attemptInspectorPort,
} = deriveDevPorts({ basePort });

const residualPorts = await detectResidualDevPorts({
	ports: [workerPort, attemptWorkerPort, uiPort],
});

const backgroundStatus = classifyBackgroundDevState({
	pidRunning: Boolean(state),
	healthSummary,
	hasResidualPorts: residualPorts.length > 0,
});

const stopPlan = buildStopPlan({
	liveState: state,
	residualPorts,
});
```

- [ ] **Step 4: 运行脚本测试与原有 `dev-shared` 测试确认通过**

Run: `bun test tests/scripts/dev-shared.test.ts tests/scripts/dev-runtime.test.ts`
Expected: PASS

- [ ] **Step 5: 提交一次小步 commit**

```bash
git add scripts/dev.mjs scripts/dev-shared.mjs scripts/dev-shared.d.mts tests/scripts/dev-runtime.test.ts tests/scripts/dev-shared.test.ts
git commit -m "fix: detect residual dev ports and single-port config"
```

### Task 5: 同步文档与环境模板

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: 更新 README 的端口与状态说明**

```md
- `--status`：查看后台运行状态；若守护进程异常退出但派生端口仍残留，会显示残留实例提示
- `--stop`：停止后台运行实例；若仅存在残留实例，也会尝试清理

默认端口（由 `DEV_PORT` 派生）：

- Worker: `DEV_PORT`
- Attempt Worker: `DEV_PORT + 1`
- UI: `DEV_PORT + 2`

支持环境变量覆盖：

- `DEV_PORT`：本地开发主端口（默认 `8787`）
```

- [ ] **Step 2: 更新 `.env.example` 模板**

```env
# Local dev base port (optional, used by `bun run dev`)
DEV_PORT=8787
```

- [ ] **Step 3: 运行测试确认文档改动未影响脚本**

Run: `bun test tests/scripts/dev-shared.test.ts tests/scripts/dev-runtime.test.ts`
Expected: PASS

- [ ] **Step 4: 提交一次小步 commit**

```bash
git add README.md .env.example
git commit -m "docs: document single dev port behavior"
```

### Task 6: 完整验证与本地回归

**Files:**
- Modify: `scripts/dev.mjs`
- Modify: `scripts/dev-shared.mjs`
- Modify: `scripts/dev-shared.d.mts`
- Modify: `tests/scripts/dev-shared.test.ts`
- Create: `tests/scripts/dev-runtime.test.ts`
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: 格式化改动文件**

Run: `bunx --bun biome format --write scripts/dev.mjs scripts/dev-shared.mjs scripts/dev-shared.d.mts tests/scripts/dev-shared.test.ts tests/scripts/dev-runtime.test.ts README.md .env.example`
Expected: exit 0

- [ ] **Step 2: 运行类型检查**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: 运行完整测试**

Run: `bun run test`
Expected: PASS

- [ ] **Step 4: 验证后台状态命令**

Run: `bun run dev -- --status`
Expected: 能输出“未运行”或“残留实例”之一，不应在残留场景下误报纯未运行

- [ ] **Step 5: 验证停止命令**

Run: `bun run dev -- --stop`
Expected: 在存在守护进程或残留实例时执行清理；否则明确输出无需停止

- [ ] **Step 6: 提交最终整理 commit**

```bash
git add scripts/dev.mjs scripts/dev-shared.mjs scripts/dev-shared.d.mts tests/scripts/dev-shared.test.ts tests/scripts/dev-runtime.test.ts README.md .env.example docs/superpowers/specs/2026-06-12-dev-single-port-and-residual-cleanup-design.md docs/superpowers/plans/2026-06-12-dev-single-port-and-residual-cleanup.md
git commit -m "fix: harden dev background status and port config"
```
