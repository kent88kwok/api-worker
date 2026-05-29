# 渠道有效模型实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将渠道模型可用性改为自动验证基础集叠加手动补充与排除。

**Architecture:** 新增一个小型有效模型服务，集中解析 metadata 并计算每个渠道的有效模型。模型列表接口、OpenAI 模型列表和路由选择都调用该服务；模型广场只读总览，渠道编辑弹窗负责读写当前渠道的正式、待加入、排除状态。

**Tech Stack:** TypeScript, Hono, Cloudflare D1, Hono JSX UI, Vitest, Biome.

---

### Task 1: 后端有效模型服务

**Files:**
- Create: `apps/worker/src/services/channel-effective-models.ts`
- Test: `tests/worker/channel-effective-models.test.ts`

- [ ] 写失败测试：覆盖 verified/include/exclude 合并、旧 `models_json` 兜底、去重。
- [ ] 运行 `bunx --bun vitest run tests/worker/channel-effective-models.test.ts`，确认因缺少实现失败。
- [ ] 实现 `parseManualModelConfig`、`resolveEffectiveModelIds`、`listEffectiveModelsByChannel`、`listEffectiveModelEntries`。
- [ ] 运行同一测试确认通过。

### Task 2: 路由和模型列表接入

**Files:**
- Modify: `apps/worker/src/services/channel-routing.ts`
- Modify: `apps/worker/src/services/openai-model-list.ts`
- Modify: `apps/worker/src/routes/models.ts`
- Modify: `apps/worker/src/routes/newapiUsers.ts`
- Modify: `apps/worker/src/routes/newapiChannels.ts`
- Test: `tests/worker/channel-routing.test.ts`

- [ ] 写失败测试：手动补充模型可选中渠道，手动排除模型不能选中渠道，只有 `models_json` 且有验证集时不能污染候选。
- [ ] 运行单测确认失败。
- [ ] 将路由和模型列表统一切到有效模型 map。
- [ ] 运行相关单测确认通过。

### Task 3: 站点 API 与渠道内模型配置

**Files:**
- Modify: `apps/worker/src/services/site-metadata.ts`
- Modify: `apps/worker/src/routes/sites.ts`
- Modify: `apps/ui/src/core/types.ts`
- Modify: `apps/ui/src/App.tsx`
- Modify: `apps/ui/src/features/ChannelsView.tsx`
- Create: `apps/ui/src/features/channel-models.ts`

- [ ] 写站点 metadata 单测，确认 include/exclude 在更新 site_type 时保留并可更新。
- [ ] 实现 metadata 读写和站点接口字段。
- [ ] 渠道页加载模型聚合数据，并传给渠道编辑弹窗。
- [ ] 在渠道编辑弹窗中增加结构化模型管理区：拉取模型、输入模型 ID 添加、搜索/筛选/分页展示，并支持正式、待加入、排除、删除。
- [ ] 保持模型广场只读，只做全局检索和状态总览。

### Task 4: 文档与验证

**Files:**
- Modify: `README.md`

- [ ] 更新模型列表和渠道刷新说明，明确空渠道首次拉取进入正式、已有模型后续新增进入待加入。
- [ ] 运行 `bunx --bun biome format --write <changed-files>`。
- [ ] 运行 `bun run typecheck`。
- [ ] 运行 `bun run test`。
