import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getChannelById } from "../domains/channel/repo";
import { listCallTokens } from "../domains/channel/call-token-repo";
import { extractModelIds } from "../domains/channel/models";
import { parseChannelMetadata, resolveProvider } from "../domains/channel/metadata";
import { resolveChannelBaseUrl } from "../domains/proxy/request/planning";
import { getProviderAdapter } from "../services/providers";
import { safeJsonParse } from "../utils/json";

// 渠道模型可用性探测端点（POST/GET /api/probe/:id）
//
// 背景：api-worker 后台的模型清单来自预置的「规范模型」全量种子，并不会拿你的 Key
// 去逐个验证「这个模型我到底能不能用」。对新用户 Key，列表里一半模型实际会 404。
//
// 本端点：
//  1) 读取该渠道 models_json 中的【真实模型清单】（不是写死的候选列表），逐一探测；
//  2) 复用网关自身的 provider 适配器来构造上游请求（auth 头 + 端点路径），
//     因此 Gemini 走 x-goog-api-key + /models/{model}:generateContent、
//     OpenAI 走 Bearer + /chat/completions、Anthropic 走 x-api-key + /v1/messages，
//     与真实流量完全一致；
//  3) 结果写回 channels.metadata_json.probed_models（parseChannelMetadata 会忽略该未知字段）。

type D1 = AppEnv["Bindings"]["DB"];
type ProviderType = "openai" | "anthropic" | "gemini";
type ProbeUnavailable = { model: string; status: number; message: string };
type ProbeResult = {
	probed_at: string;
	provider: string;
	total: number;
	available: string[];
	unavailable: ProbeUnavailable[];
};

function buildProbeTarget(
	provider: ProviderType,
	baseUrl: string,
	model: string,
): { url: string; body: unknown } {
	const base = resolveChannelBaseUrl({
		base_url: baseUrl,
	} as never);
	if (provider === "gemini") {
		// Gemini 原生端点；若 base_url 末尾带了 /openai 兼容段则去掉，回到 /v1beta 基线
		const nativeBase = base.replace(/\/openai\/?$/i, "");
		return {
			url: `${nativeBase}/models/${encodeURIComponent(model)}:generateContent`,
			body: {
				contents: [{ role: "user", parts: [{ text: "ping" }] }],
				generationConfig: { maxOutputTokens: 5 },
			},
		};
	}
	if (provider === "anthropic") {
		const clean = base.replace(/\/v1\/?$/i, "");
		return {
			url: `${clean}/v1/messages`,
			body: {
				model,
				max_tokens: 5,
				messages: [{ role: "user", content: "ping" }],
			},
		};
	}
	// openai / generic —— OpenAI 兼容 /chat/completions
	return {
		url: `${base}/chat/completions`,
		body: {
			model,
			messages: [{ role: "user", content: "ping" }],
			max_tokens: 5,
			stream: false,
		},
	};
}

async function probeModel(
	provider: ProviderType,
	baseUrl: string,
	apiKey: string,
	headerOverrides: Record<string, string>,
	model: string,
): Promise<{ ok: boolean; status: number; message: string }> {
	const { url, body } = buildProbeTarget(provider, baseUrl, model);
	const headers = getProviderAdapter(provider).buildAuthHeaders(
		new Headers(),
		apiKey,
		headerOverrides,
	);
	headers.set("content-type", "application/json");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 12000);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const text = await res.text();
		if (res.status === 200) return { ok: true, status: 200, message: "" };
		let message = text.slice(0, 200);
		try {
			const j = JSON.parse(text);
			if (j?.error?.message) message = String(j.error.message).slice(0, 200);
		} catch {}
		return { ok: false, status: res.status, message };
	} catch (e) {
		return { ok: false, status: 0, message: String(e).slice(0, 200) };
	} finally {
		clearTimeout(timer);
	}
}

const PROBE_CONCURRENCY = 24;

async function runProbe(db: D1, id: string): Promise<ProbeResult | null> {
	const channel = await getChannelById(db, id);
	if (!channel) return null;
	const ch = channel as unknown as {
		api_key?: string;
		base_url?: string;
		metadata_json?: string | null;
		models_json?: string | null;
	};
	const meta = parseChannelMetadata(ch.metadata_json ?? null);
	const provider = resolveProvider(meta.site_type) as ProviderType;
	const tokenRows = await listCallTokens(db, { channelIds: [id] });
	const apiKey =
		tokenRows.length > 0
			? String(tokenRows[0].api_key ?? "")
			: String(ch.api_key ?? "");
	const models = extractModelIds({
		models_json: ch.models_json ?? null,
	} as never);
	const total = models.length;

	if (!apiKey) {
		return {
			probed_at: new Date().toISOString(),
			provider,
			total,
			available: [],
			unavailable: [
				{
					model: "(无可用 Key)",
					status: 0,
					message: "渠道未配置 API Key",
				},
			],
		};
	}
	if (models.length === 0) {
		return {
			probed_at: new Date().toISOString(),
			provider,
			total: 0,
			available: [],
			unavailable: [],
		};
	}

	const base = resolveChannelBaseUrl(channel as never);
	const available: string[] = [];
	const unavailable: ProbeUnavailable[] = [];
	let cursor = 0;
	const worker = async () => {
		while (cursor < models.length) {
			const model = models[cursor++];
			const r = await probeModel(
				provider,
				base,
				apiKey,
				meta.header_overrides,
				model,
			);
			if (r.ok) available.push(model);
			else unavailable.push({ model, status: r.status, message: r.message });
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(PROBE_CONCURRENCY, models.length) }, () =>
			worker(),
		),
	);
	return {
		probed_at: new Date().toISOString(),
		provider,
		total,
		available,
		unavailable,
	};
}

const app = new Hono<AppEnv>();

// 触发探测并持久化结果
app.post("/:id", async (c) => {
	const id = c.req.param("id");
	const result = await runProbe(c.env.DB, id);
	if (!result) return c.json({ error: "channel_not_found" }, 404);
	const current = await getChannelById(c.env.DB, id);
	const ch = current as unknown as { metadata_json?: string | null };
	const meta = safeJsonParse<Record<string, unknown>>(ch.metadata_json ?? null, {});
	meta.probed_models = result;
	await c.env.DB.prepare("UPDATE channels SET metadata_json = ? WHERE id = ?")
		.bind(JSON.stringify(meta), id)
		.run();
	return c.json(result);
});

// 读取已持久化的探测结果（供页面加载时显示「自己验证过的」结论）
app.get("/:id", async (c) => {
	const id = c.req.param("id");
	const channel = await getChannelById(c.env.DB, id);
	if (!channel) return c.json({ error: "channel_not_found" }, 404);
	const ch = channel as unknown as { metadata_json?: string | null };
	const meta = safeJsonParse<Record<string, unknown>>(ch.metadata_json ?? null, {});
	return c.json({
		probed_models: (meta.probed_models as ProbeResult) ?? null,
	});
});

export default app;
