# 自定义请求入口设计

## 目标

部分 OpenAI 兼容上游不使用标准路径，例如只在 `/codex` 接收 Responses 格式请求。渠道编辑需要支持一个轻量的自定义请求入口，不引入完整端点矩阵，也不自动在 Chat Completions 和 Responses 之间互转。

## 行为

- 渠道默认不配置请求入口，继续按现有标准路径转发。
- 请求入口包含两个字段：
  - `path`：相对路径或完整 URL，例如 `/codex`。
  - `format`：按站点类型展示的显式协议名，例如 `openai_chat`、`openai_responses`、`anthropic_messages`、`gemini_generate_content`；为空表示“自动”。
- 当 `format` 为空时，OpenAI Chat/Responses 会按当前下游请求类型选择对应入口：Chat 请求只试 `openai_chat`，Responses 请求只试 `openai_responses`，不会在失败后自动互转；支持多 provider 的站点类型仍可按能力继续尝试非 OpenAI provider 格式，且不会把站点配置固化为某个明确格式。
- 当请求格式为 `openai_responses` 时，只有下游 `/v1/responses` 请求使用该入口；请求体保持 Responses 形状。
- 当请求格式为 `openai_chat` 时，只有下游 `/v1/chat/completions` 请求使用该入口；请求体保持 Chat Completions 形状。
- 当请求格式为 `anthropic_messages` 时，只有下游 Anthropic Messages 请求使用该入口。
- 当请求格式为 `gemini_generate_content` 时，只有下游 Gemini Generate Content 请求使用该入口。
- 格式不匹配时，该渠道在本次请求中跳过。
- 模型拉取仍使用模型发现接口，暂不受自定义请求入口影响。

## 数据

配置保存到 `channels.metadata_json.request_entry`：

```json
{
  "request_entry": {
    "path": "/codex",
    "format": "openai_responses"
  }
}
```

相对路径会补齐开头 `/`，完整 URL 会原样作为上游目标。

## UI

站点编辑弹窗在基础 URL 下方增加：

- 请求入口：留空表示自动，支持 `/codex` 或完整 URL。
- 请求格式：自动、OpenAI Chat、OpenAI Responses、Anthropic Messages、Gemini Generate Content。

旧值 `chat` / `responses` 仍会兼容解析为 `openai_chat` / `openai_responses`。

如果填写请求入口并保持“自动”，前端允许保存；成功请求不会把格式切换为明确值。

## 测试

- metadata 能解析和保存请求入口。
- metadata 能保存路径 + 自动格式。
- `openai_responses` 入口将 `/v1/responses` 转发到自定义路径并保留 body。
- `openai_responses` 入口会跳过 `/v1/chat/completions`。
- 自动入口按当前 OpenAI 下游请求类型尝试，且 HTTP 200 后仍保持自动格式。
- 前端最小回归确认编辑弹窗能看到并保存请求入口字段。
