import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getChannelById } from "../domains/channel/repo";
import { listCallTokens } from "../domains/channel/call-token-repo";
import { parseChannelMetadata, resolveProvider } from "../domains/channel/metadata";
import { normalizeBaseUrl } from "../utils/url";
import { getProviderAdapter } from "../services/providers";
import type { ProviderType } from "../services/providers";

// 游乐场（Playground）：在管理台内直接选渠道/模型发一条消息，验证某个
// Key / 供应商是否真的可用（参考 new-api 的 Playground）。
//
// 设计要点：
//  1) 走管理台鉴权（/api/playground 不在 index.ts 的豁免列表里，默认需 admin token），
//     避免任何人都能拿你的 Key 去烧钱。
//  2) 服务端用渠道自身的 provider 适配器构造请求（含 x-goog-api-key / x-api-key / Bearer），
//     与探测、真实流量同构，复用我们已修好的 Gemini 等适配逻辑。
//  3) 支持 openai / anthropic / gemini 三种 provider 的聊天体构造。

type D1 = AppEnv["Bindings"]["DB"];
type ChatRole = "system" | "user" | "assistant";
type ChatMessage = { role: ChatRole; content: string };
type PlaygroundBody = {
	channel_id: string;
	model: string;
	messages: ChatMessage[];
	temperature?: number;
	max_tokens?: number;
	stream?: boolean;
};

const PLAYGROUND_TIMEOUT_MS = 60000;

function buildChatTarget(
	provider: ProviderType,
	baseUrl: string,
	model: string,
	messages: ChatMessage[],
	params: { temperature?: number; max_tokens?: number; stream?: boolean },
	headerOverrides: Record<string, string>,
): { url: string; body: unknown } {
	const base = normalizeBaseUrl(baseUrl);
	const systemText = messages
		.filter((m) => m.role === "system")
		.map((m) => m.content)
		.join("\n");
	const convo = messages
		.filter((m) => m.role !== "system")
		.map((m) => ({ role: m.role, content: m.content }));

	if (provider === "gemini") {
		// Gemini 原生端点：/models/{model}:generateContent（与探测同构，已验证可用）
		const nativeBase = base.replace(/\/openai\/?$/i, "");
		const contents = convo.map((m) => ({
			role: m.role === "assistant" ? "model" : "user",
			parts: [{ text: m.content }],
		}));
		const generationConfig: Record<string, unknown> = {};
		if (params.max_tokens) generationConfig.maxOutputTokens = params.max_tokens;
		if (params.temperature != null) generationConfig.temperature = params.temperature;
		if (params.stream) generationConfig.streaming = true;
		const body: Record<string, unknown> = { contents, generationConfig };
		if (systemText) {
			body.systemInstruction = { parts: [{ text: systemText }] };
		}
		return {
			url: `${nativeBase}/models/${encodeURIComponent(model)}:generateContent`,
			body,
		};
	}

	if (provider === "anthropic") {
		const body: Record<string, unknown> = {
			model,
			max_tokens: params.max_tokens ?? 1024,
			messages: convo,
			stream: Boolean(params.stream),
		};
		if (systemText) body.system = systemText;
		if (params.temperature != null) body.temperature = params.temperature;
		return { url: `${base}/v1/messages`, body };
	}

	// openai / 通用 OpenAI 兼容（覆盖 Ollama、new-api、OpenAI 网关等）
	const body: Record<string, unknown> = {
		model,
		messages,
		stream: Boolean(params.stream),
	};
	if (params.temperature != null) body.temperature = params.temperature;
	if (params.max_tokens) body.max_tokens = params.max_tokens;
	return { url: `${base}/v1/chat/completions`, body };
}

function extractContent(provider: ProviderType, j: unknown): string {
	const o = (j ?? {}) as Record<string, any>;
	if (provider === "openai") {
		return o?.choices?.[0]?.message?.content ?? o?.choices?.[0]?.text ?? "";
	}
	if (provider === "gemini") {
		const parts = o?.candidates?.[0]?.content?.parts;
		if (Array.isArray(parts)) return parts.map((p: any) => p?.text ?? "").join("");
		return o?.candidates?.[0]?.text ?? "";
	}
	// anthropic
	if (Array.isArray(o?.content)) return o.content.map((p: any) => p?.text ?? "").join("");
	return o?.content ?? "";
}

const app = new Hono<AppEnv>();

app.post("/chat", async (c) => {
	const body = (await c.req.json().catch(() => null)) as PlaygroundBody | null;
	if (
		!body ||
		!body.channel_id ||
		!body.model ||
		!Array.isArray(body.messages) ||
		body.messages.length === 0
	) {
		return c.json({ ok: false, error: "invalid_request" }, 400);
	}

	const channel = await getChannelById(c.env.DB, body.channel_id);
	if (!channel) {
		return c.json({ ok: false, error: "channel_not_found" }, 404);
	}
	const ch = channel as unknown as {
		api_key?: string;
		base_url?: string;
		metadata_json?: string | null;
	};
	const meta = parseChannelMetadata(ch.metadata_json ?? null);
	const provider = resolveProvider(meta.site_type) as ProviderType;
	const tokenRows = await listCallTokens(c.env.DB, { channelIds: [body.channel_id] });
	const apiKey =
		tokenRows.length > 0
			? String(tokenRows[0].api_key ?? "")
			: String(ch.api_key ?? "");
	if (!apiKey) {
		return c.json({ ok: false, error: "no_api_key" }, 400);
	}

	const base = normalizeBaseUrl(ch.base_url ?? "");
	const { url, body: upstreamBody } = buildChatTarget(
		provider,
		base,
		body.model,
		body.messages,
		{
			temperature: body.temperature,
			max_tokens: body.max_tokens,
			stream: body.stream,
		},
		meta.header_overrides,
	);

	const headers = getProviderAdapter(provider).buildAuthHeaders(
		new Headers(),
		apiKey,
		meta.header_overrides,
	);
	headers.set("content-type", "application/json");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PLAYGROUND_TIMEOUT_MS);
	try {
		const upstream = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(upstreamBody),
			signal: controller.signal,
		});

		// 流式：原样透传上游 SSE（仅 OpenAI 兼容格式在 UI 端能解析增量）
		if (body.stream) {
			return new Response(upstream.body, {
				status: upstream.status,
				headers: {
					"content-type":
						upstream.headers.get("content-type") ?? "text/event-stream",
					"cache-control": "no-cache",
				},
			});
		}

		const text = await upstream.text();
		if (!upstream.ok) {
			return c.json(
				{ ok: false, status: upstream.status, error: text.slice(0, 500) },
				(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502) as 400,
			);
		}
		const content = extractContent(provider, safeJsonParse(text));
		return c.json({
			ok: true,
			status: upstream.status,
			content,
			raw: text.slice(0, 4000),
		});
	} catch (e) {
		return c.json(
			{ ok: false, error: `请求上游失败：${String(e).slice(0, 300)}` },
			502,
		);
	} finally {
		clearTimeout(timer);
	}
});

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

export default app;
