# AGENTS.md

本文件定义本仓库内 Agent 的统一执行规范。

## 1. 基本原则

- 变更优先最小化，避免无关改动。
- 文档与代码保持一致；行为变化必须同步文档。
- 所有回答和提交说明使用中文（保留代码与 API 原文）。

## 2. 文件与目录规范

- 目录优先表达领域边界，避免在同一层堆叠大量前缀文件模拟目录。
- 文件名使用 kebab-case；React 组件文件可使用 PascalCase。
- 小于 30 行且只被同领域使用的小文件应优先合并，除非它是类型定义、框架约定入口或公共出口。
- 超过 400 行的源文件应优先拆分纯逻辑、子组件、请求构造、响应转换、持久化访问和类型定义。
- Worker 业务逻辑统一放在 `apps/worker/src/domains/<domain>/`，`routes` 只保留 HTTP 入参、鉴权上下文和响应适配。
- UI 按 `apps/ui/src/app/`、`apps/ui/src/features/<feature>/`、`apps/ui/src/core/`、`apps/ui/src/components/` 分层；只被单一 feature 使用的工具函数留在该 feature 目录。
- 测试目录跟随源码领域：worker 测试放在 `tests/unit/worker/<domain>/`，UI 测试放在 `tests/unit/ui/<feature>/`，e2e 测试放在 `tests/e2e/`。
- 生成物必须有明确边界；不可跟踪的构建产物应写入 `.gitignore`，必须跟踪的生成目录需配套 README 说明来源和原因。

## 3. 完成后必须执行

每次任务完成后，必须执行以下检查（按顺序）：

1. `bunx --bun biome format --write <changed-files>`
2. `bun run typecheck`
3. `bun run test`

如果任一步失败，先修复再交付。

## 4. 前后端验证规则

- 前端改动：必须使用自动化工具做最小可用回归（页面加载、关键交互、无控制台报错）。
- 后端改动：必须通过直接请求验证接口行为（`curl`/`Invoke-RestMethod`）。

## 5. 结果汇报要求

- 明确列出改动文件。
- 明确列出执行过的命令和结果（通过/失败）。
- 若有未完成项或风险，必须显式说明。
- 任务完成时，主动建议用户执行 `git commit`（若本次未代为提交）。
