# C4 架构图

本文基于当前仓库代码和配置绘制，重点描述 `api-worker` 产品在运行时的系统边界、容器关系和主 Worker 内部组件。

## C1 系统上下文

```mermaid
C4Context
	title api-worker 系统上下文
	Person(admin, "管理员", "维护渠道、令牌、模型、价格、用量、备份和系统设置")
	Person(client, "API 调用方", "使用 OpenAI 兼容接口发起模型请求")
	System(apiWorker, "api-worker", "Cloudflare Workers + D1 的多上游 AI API 网关与管理台")
	System_Ext(upstreams, "AI 上游渠道", "OpenAI / Anthropic / Gemini / New API / Done Hub / SubAPI 等兼容服务")
	System_Ext(priceSources, "在线价格源", "模型价格同步来源")
	System_Ext(webdav, "WebDAV 服务", "可选的数据备份与双向同步目标")
	System_Ext(cloudflare, "Cloudflare 平台", "Workers、D1、KV、Durable Objects、Static Assets、Observability")

	Rel(admin, apiWorker, "使用管理台维护配置", "HTTPS /api/*")
	Rel(client, apiWorker, "调用模型代理", "HTTPS /v1/*, /v1beta/*")
	Rel(apiWorker, upstreams, "路由、鉴权转换、重试和响应透传", "HTTPS")
	Rel(apiWorker, priceSources, "同步模型价格与汇率", "HTTPS")
	Rel(apiWorker, webdav, "推送/拉取备份", "WebDAV")
	Rel(apiWorker, cloudflare, "运行并持久化状态", "Cloudflare bindings")
```

## C2 容器图

```mermaid
C4Container
	title api-worker 容器图
	Person(admin, "管理员")
	Person(client, "API 调用方")
	System_Ext(upstreams, "AI 上游渠道")
	System_Ext(priceSources, "在线价格源")
	System_Ext(webdav, "WebDAV 服务")

	System_Boundary(system, "api-worker") {
		Container(ui, "管理台 SPA", "Vite + TypeScript + Hono JSX", "渠道、模型、价格、令牌、用量和设置管理界面")
		Container(worker, "主 Worker", "Cloudflare Worker + Hono + WASM", "承载静态资源、管理 API、OpenAI 兼容代理、调度器入口和核心编排逻辑")
		Container(attemptWorker, "attempt-worker", "Cloudflare Worker + Hono", "单次上游调用执行器，处理大请求 dispatch、独立调用、流式元信息提取")
		ContainerDb(d1, "D1 数据库", "Cloudflare D1 / SQLite", "渠道、调用令牌、访问令牌、模型能力、价格、用量、尝试事件、设置、会话")
		ContainerDb(kvHot, "KV_HOT", "Cloudflare KV", "模型/路由热缓存、Responses 亲和缓存、能力缓存")
		ContainerDb(scheduler, "CheckinScheduler", "Durable Object", "按北京时间触发签到、模型刷新、恢复探测、备份、价格同步")
		Container(assets, "静态资源绑定", "Cloudflare Assets", "发布后的 `apps/ui/dist`")
	}

	Rel(admin, ui, "访问管理台", "Browser")
	Rel(ui, worker, "管理 API", "HTTPS /api/*")
	Rel(client, worker, "模型代理 API", "HTTPS /v1/*, /v1beta/*")
	Rel(worker, assets, "未命中 API 时返回 SPA")
	Rel(worker, d1, "读写业务配置和运行数据")
	Rel(worker, kvHot, "读取/写入热缓存")
	Rel(worker, scheduler, "重排定时任务、查询状态")
	Rel(worker, attemptWorker, "按策略委托上游调用或站点任务", "service binding 或本地 URL")
	Rel(attemptWorker, d1, "复用绑定，执行站点任务时可访问同一数据库")
	Rel(attemptWorker, kvHot, "复用热缓存绑定")
	Rel(attemptWorker, scheduler, "引用主 Worker Durable Object")
	Rel(worker, upstreams, "常规代理尝试、模型发现、服务验证", "HTTPS")
	Rel(attemptWorker, upstreams, "单次调用、dispatch、站点任务执行", "HTTPS")
	Rel(worker, priceSources, "价格同步与汇率刷新", "HTTPS")
	Rel(worker, webdav, "备份推送/拉取", "WebDAV")
```

## C3 主 Worker 组件图

```mermaid
C4Component
	title apps/worker 主 Worker 组件图
	ContainerDb(d1, "D1 数据库", "Cloudflare D1")
	ContainerDb(kvHot, "KV_HOT", "Cloudflare KV")
	Container(attemptWorker, "attempt-worker", "Cloudflare Worker")
	System_Ext(upstreams, "AI 上游渠道")
	System_Ext(priceSources, "在线价格源")
	System_Ext(webdav, "WebDAV 服务")

	Container_Boundary(worker, "apps/worker") {
		Component(entry, "Hono 应用入口", "src/index.ts", "注册 CORS、鉴权中间件、路由、静态资源回退和错误处理")
		Component(adminRoutes, "管理 API 路由", "src/routes/*", "auth、sites/channels、models、canonical-models、pricing、tokens、usage、dashboard、settings、backup")
		Component(newApiRoutes, "New API 兼容路由", "routes/newapi*.ts", "兼容 `/api/channel`、`/api/group`、`/api/user`")
		Component(proxy, "OpenAI 兼容代理", "shared/proxy.ts + services/proxy/*", "Token 鉴权、模型归一、渠道筛选、请求改写、重试、错误策略、响应收尾")
		Component(channelServices, "渠道与模型服务", "services/channel-*.ts, model-*.ts", "渠道仓库、模型能力、冷却、有效模型、调用令牌、统一模型注册")
		Component(usageServices, "用量与尝试事件服务", "services/usage*.ts, attempt-events.ts, pricing/*", "记录 usage、计费金额、尝试日志、价格匹配和同步")
		Component(siteTasks, "站点任务服务", "services/site-*.ts, checkin*.ts", "签到、模型刷新、站点验证、禁用渠道恢复探测")
		Component(schedulerComponent, "CheckinScheduler Durable Object", "services/checkin-scheduler.ts", "聚合多个周期任务并写入任务报告")
		Component(backupServices, "备份同步服务", "services/backup*.ts, webdav.ts", "导入导出、WebDAV 推送/拉取、数据变更后自动备份")
		Component(wasmCore, "WASM 核心", "wasm/core.ts + wasm/generated", "在 Worker 和 attempt-worker 启动时预热，提供共享底层能力")
	}

	Rel(entry, adminRoutes, "挂载 `/api/*`")
	Rel(entry, newApiRoutes, "挂载 New API 兼容路由")
	Rel(entry, proxy, "挂载 `/v1/*`、`/v1beta/*`")
	Rel(adminRoutes, channelServices, "维护渠道、令牌和模型")
	Rel(adminRoutes, usageServices, "查询看板、用量和价格")
	Rel(adminRoutes, siteTasks, "触发站点验证、签到、刷新、恢复探测")
	Rel(adminRoutes, backupServices, "导入导出和同步备份")
	Rel(proxy, channelServices, "选择可路由渠道、模型映射和冷却判断")
	Rel(proxy, usageServices, "记录用量、尝试事件和计费结果")
	Rel(proxy, attemptWorker, "大请求或策略触发时委托调用")
	Rel(proxy, upstreams, "常规上游代理调用")
	Rel(channelServices, d1, "读写渠道、调用令牌、模型能力、统一模型")
	Rel(usageServices, d1, "写入 usage_logs、attempt_events、model_prices")
	Rel(usageServices, priceSources, "同步模型价格")
	Rel(siteTasks, d1, "读写站点任务结果和渠道状态")
	Rel(siteTasks, attemptWorker, "可选 offload，失败后本地 fallback")
	Rel(siteTasks, upstreams, "模型发现、服务验证、签到")
	Rel(schedulerComponent, siteTasks, "定时触发站点任务")
	Rel(schedulerComponent, backupServices, "定时触发备份")
	Rel(schedulerComponent, usageServices, "定时触发价格同步")
	Rel(backupServices, d1, "导出/导入业务数据")
	Rel(backupServices, webdav, "远端同步")
	Rel(proxy, kvHot, "读写路由热缓存、Responses 亲和缓存")
	Rel(channelServices, kvHot, "数据变化后失效缓存")
	Rel(wasmCore, proxy, "提供共享运行能力")
	Rel(wasmCore, siteTasks, "提供共享运行能力")
```

## API 调用全流程

这张图聚焦 `ALL /v1/*` 与 `ALL /v1beta/*` 的代理主链路，包含模型归一、统一模型、渠道选择、attempt 执行和错误策略。

```mermaid
flowchart TD
	start["API 请求进入主 Worker<br/>/v1/* 或 /v1beta/*"] --> auth["tokenAuth<br/>读取 Bearer token，按 key_hash 查 D1"]
	auth --> authOk{"访问令牌可用？"}
	authOk -- 否 --> authErr["直接返回<br/>401 token_required/invalid_token<br/>402 quota_exceeded<br/>403 token_expired/token_disabled"]
	authOk -- 是 --> modelsReq{"是否 GET /v1/models？"}
	modelsReq -- 是 --> modelsList["读取 active 渠道<br/>按 token.allowed_channels 过滤<br/>返回本地聚合模型列表<br/>不请求上游"]
	modelsReq -- 否 --> settings["读取运行设置<br/>重试、超时、冷却、禁用、usage、offload、Responses 亲和"]

	settings --> detect["按路径识别 downstreamProvider 与 endpointType<br/>openai / anthropic / gemini<br/>chat / responses / embeddings / images / passthrough"]
	detect --> detectOk{"识别成功？"}
	detectOk -- 否 --> detectErr["502 provider_detect_failed<br/>写入早期 usage error"]
	detectOk -- 是 --> body["读取请求体<br/>判断大请求 offload<br/>OpenAI 请求会修复 tool_call 链与 responses 图片字段"]

	body --> modelRaw["提取 requestModelRaw<br/>来源：请求体 model 或 Gemini 路径模型"]
	modelRaw --> canonical["resolveCanonicalModel<br/>先查 model_aliases/model_registry<br/>未命中则启发式归一并写回 alias/registry"]
	canonical --> downstream["得到 downstreamModel<br/>canonicalModel 存在则使用统一模型<br/>否则使用 requestModelRaw"]
	downstream --> validate["校验工具 schema 与 OpenAI tool_call 链"]
	validate --> validateOk{"请求结构有效？"}
	validateOk -- 否 --> validateErr["400 request_validation<br/>或 409 tool_call_chain<br/>写入早期 usage error"]
	validateOk -- 是 --> loadChannels["读取 active channels 与 channel_call_tokens<br/>优先 KV_HOT，未命中查 D1 后回写短缓存"]

	loadChannels --> allowed["按访问令牌 allowed_channels 过滤渠道"]
	allowed --> compatible["selectCandidateChannels<br/>检查显式模型映射、已验证/有效模型、手工排除列表"]
	compatible --> attemptable["resolveAttemptableChannels<br/>检查 passthrough provider、上游模型、Gemini 模型要求、匹配调用令牌"]
	attemptable --> affinity["OpenAI Responses 亲和处理<br/>function_call_output 需要 previous_response_id<br/>命中 KV 亲和时优先固定到原渠道"]
	affinity --> affinityOk{"亲和要求满足？"}
	affinityOk -- 否 --> affinityErr["409 responses_previous_response_id_required<br/>或亲和相关错误<br/>写入早期 usage error"]
	affinityOk -- 是 --> cooldown["过滤处于模型冷却期的渠道"]
	cooldown --> candidatesOk{"还有候选渠道？"}
	candidatesOk -- 否 --> candidateErr["503 upstream_cooldown<br/>或 no_available_channels<br/>或 no_routable_channels<br/>写入早期 usage error"]
	candidatesOk -- 是 --> order["buildAttemptSequence<br/>按优先级、权重、最大重试数生成渠道顺序"]
	order --> orderOk{"排序成功？"}
	orderOk -- 否 --> orderErr["502 weighted_order_failed<br/>写入早期 usage error"]
	orderOk -- 是 --> plan["buildChannelAttemptPlan<br/>结合统一模型 alias、渠道原始模型、模型映射<br/>固定每次尝试的 upstreamModel"]

	plan --> dispatch{"大请求或 dispatch 策略命中？"}
	dispatch -- 是 --> attemptWorker["发送到 attempt-worker<br/>/internal/attempt/dispatch<br/>由执行器逐个请求上游并返回元信息头"]
	dispatch -- 否 --> localLoop["主 Worker 本地 attempt loop"]
	attemptWorker --> attemptResult["得到单次 attempt 响应"]
	localLoop --> prepare["prepareAttemptRequest<br/>解析 request_entry<br/>转换 provider 请求体<br/>注入上游鉴权头<br/>处理 stream_options 与 query/header overrides"]
	prepare --> fetchUpstream["请求 AI 上游渠道"]
	fetchUpstream --> attemptResult

	attemptResult --> upstreamOk{"上游响应可作为成功？"}
	upstreamOk -- 是 --> successCheck["检查 usage、流式元信息、异常成功响应、zero completion"]
	successCheck --> successOk{"通过成功判定？"}
	successOk -- 是 --> selected["选中 selectedResponse<br/>记录 attempt ok<br/>必要时更新模型能力"]
	successOk -- 否 --> successFailure["构造成功响应失败原因<br/>usage_missing / stream_meta / abnormal_success / usage_zero_completion_tokens"]
	upstreamOk -- 否 --> upstreamFailure["解析 HTTP/fetch 错误<br/>归一 error_code<br/>识别 responses_tool_call_chain_mismatch 与 stream_options_unsupported"]

	successFailure --> policy["resolveProxyErrorDecision<br/>按 return / sleep / disable / retry 策略处理"]
	upstreamFailure --> policy
	policy --> action{"策略动作"}
	action -- return --> directErr["立即返回上游/归一错误<br/>保留 trace 与 attempt 计数"]
	action -- disable --> disable["记录渠道错误命中<br/>达到阈值则临时/永久禁用渠道<br/>失效 KV_HOT 后尝试下一个"]
	action -- sleep --> sleep["等待 retry_sleep_ms 后尝试下一个"]
	action -- retry --> retry["必要时记录模型冷却<br/>尝试下一个"]
	disable --> moreAttempts{"还有 attempt？"}
	sleep --> moreAttempts
	retry --> moreAttempts
	moreAttempts -- 是 --> localLoop
	moreAttempts -- 否 --> allFailed["无成功响应<br/>返回 503 proxy_all_attempts_failed<br/>附 trace_id、失败次数、top_reason、failures"]

	selected --> finalize["finalizeSelectedResponse<br/>适配上下游响应格式<br/>写 usage_logs 与 attempt_events<br/>Responses 成功时写 response_id 亲和缓存"]
	finalize --> stream{"是否流式响应？"}
	stream -- 是 --> streamWrap["包装响应流<br/>结束/断开/失败时补记 usage 或 downstream_stream_failed"]
	stream -- 否 --> nonStream["非流式必须有 usage<br/>缺失则转 usage_missing error"]
	streamWrap --> returnOk["返回客户端<br/>附 x-ha-trace-id、attempt/candidate 计数、质量头"]
	nonStream --> returnOk
```

## 模型名称转换链路

```mermaid
flowchart LR
	raw["requestModelRaw<br/>下游请求里的原始模型名"] --> alias["normalizeModelAlias<br/>小写、去空白、去已知前缀/后缀"]
	alias --> lookup["查 model_aliases<br/>优先 provider_hint 精确命中<br/>再查全局 alias"]
	lookup --> dbHit{"命中？"}
	dbHit -- 是 --> canonicalDb["canonicalModel<br/>matchedBy = db<br/>补齐 registry/alias"]
	dbHit -- 否 --> derive["deriveCanonicalModel<br/>取最后路径段<br/>去 -it/-instruct 等家族后缀"]
	derive --> family["resolveRegisteredFamilyCanonical<br/>尝试并入已注册家族"]
	family --> canonicalHeuristic["canonicalModel<br/>matchedBy = heuristic<br/>写入 registry/alias"]
	canonicalDb --> downstream["downstreamModel = canonicalModel"]
	canonicalHeuristic --> downstream
	raw --> fallback["如果无模型名<br/>canonicalModel = null"]
	fallback --> downstreamFallback["downstreamModel = requestModelRaw 或 null"]
	downstream --> channelMap["按渠道 metadata.model_mapping<br/>和有效/已验证模型列表解析"]
	downstreamFallback --> channelMap
	channelMap --> upstream["upstreamModel<br/>真正写入上游请求体或路径的模型名"]
	upstream --> record["recordModel<br/>用于 usage_logs、attempt_events、模型冷却和能力更新"]
```

### 关键字段

| 字段 | 含义 | 主要用途 |
| --- | --- | --- |
| `requestModelRaw` | 客户端请求里的原始模型名 | 审计、alias 学习、失败排查 |
| `canonicalModel` | 统一模型名，来自 DB alias 或启发式归一 | 跨渠道匹配、价格、统计、冷却 |
| `downstreamModel` | 本次代理内部使用的目标模型，优先等于 `canonicalModel` | 渠道筛选、attempt plan |
| `upstreamModel` | 单个渠道最终请求上游时使用的模型名 | 写入上游请求体或路径 |
| `recordModel` | 本次 attempt 记录与冷却使用的模型名 | `usage_logs`、`attempt_events`、模型能力 |

统一模型解析本身不会因为 DB alias 写入失败而中断请求；代码会退回启发式结果继续路由。真正会提前失败的通常是鉴权、路径 provider 识别、请求结构校验、渠道不可路由、亲和链缺失或全部上游尝试失败。

## 代理请求时序

```mermaid
sequenceDiagram
	autonumber
	participant Client as API 调用方
	participant Worker as 主 Worker v1/v1beta
	participant D1 as D1
	participant KV as KV_HOT
	participant Attempt as attempt-worker
	participant Upstream as AI 上游渠道

	Client->>Worker: OpenAI 兼容请求
	Worker->>D1: 校验访问令牌、加载运行设置
	Worker->>KV: 读取热缓存、Responses 亲和缓存
	Worker->>D1: 加载渠道、调用令牌、模型能力、价格
	Worker->>Worker: 归一模型、筛选可用渠道、构建 attempt plan
	alt 大请求或 dispatch 策略命中
		Worker->>Attempt: internal/attempt/dispatch
		Attempt->>Upstream: 逐个执行上游请求
		Upstream-->>Attempt: 成功响应或错误
		Attempt-->>Worker: 响应体 + attempt 元信息头
	else 常规路径
		Worker->>Upstream: 逐个执行上游请求
		Upstream-->>Worker: 成功响应或错误
	end
	Worker->>D1: 写入 usage_logs、attempt_events、模型能力/冷却状态
	Worker->>KV: 写入或失效缓存
	Worker-->>Client: 透传成功响应，或返回带 trace 的错误
```

## 代码依据

- 入口与路由：`apps/worker/src/index.ts`、`apps/attempt-worker/src/index.ts`
- Cloudflare 绑定：`apps/worker/wrangler.toml`、`apps/attempt-worker/wrangler.toml`
- 数据结构：`apps/worker/src/db/schema.sql`、`apps/worker/migrations/*`
- 代理编排：`apps/worker/src/shared/proxy.ts`、`apps/worker/src/services/proxy/*`
- 调用执行器：`apps/attempt-worker/src/routes/attempt.ts`
- 站点任务与定时调度：`apps/worker/src/services/site-task-dispatcher.ts`、`apps/worker/src/services/checkin-scheduler.ts`
- 管理台：`apps/ui/src/App.tsx`、`apps/ui/src/core/api.ts`
