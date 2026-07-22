import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getChannelById } from "../domains/channel/repo";
import { listCallTokens } from "../domains/channel/call-token-repo";
import { safeJsonParse } from "../utils/json";

// 渠道模型可用性探测端点（POST/GET /api/probe/:id）
//
// 背景：api-worker 后台的模型清单来自预置的「规范模型」全量种子，并不会拿你的 Key
// 去逐个验证「这个模型我到底能不能用」。对新用户 Key，列表里一半模型实际会 404。
// 本端点复用 verifyChannelById 的取 Key 逻辑（listCallTokens 优先，回退 channel.api_key），
// 对每个候选模型向上游 OpenAI 兼容 /chat/completions 发最小请求，判定可用/不可用，
// 并把结果写回 channels.metadata_json.probed_models（parseChannelMetadata 会忽略该未知字段）。

type D1 = AppEnv["Bindings"]["DB"];
type ProbeUnavailable = { model: string; status: number; message: string };
type ProbeResult = {
	probed_at: string;
	provider: string;
	available: string[];
	unavailable: ProbeUnavailable[];
};

// 各 provider 常见候选模型，用于逐一探测当前 Key 是否可用
const CANDIDATE_MODELS: Record<string, string[]> = {
	gemini: [
		"gemini-2.5-flash-lite",
		"gemini-2.5-flash",
		"gemini-2.5-pro",
		"gemini-2.0-flash",
		"gemini-2.0-flash-lite",
		"gemini-1.5-flash",
		"gemini-1.5-pro",
	],
	openai: ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo", "o1", "o1-mini", "o3-mini"],
	anthropic: [
		"claude-3-5-sonnet-latest",
		"claude-3-5-haiku-latest",
		"claude-3-opus-latest",
	],
	generic: ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"],
};

function detectProvider(baseUrl: string): keyof typeof CANDIDATE_MODELS {
	const u = (baseUrl || "").toLowerCase();
	if (u.includes("generativelanguage") || u.includes("googleapis"))
		return "gemini";
	if (u.includes("anthropic")) return "anthropic";
	if (u.includes("openai")) return "openai";
	return "generic";
}

// 用渠道真实 Key 向上游 OpenAI 兼容端点发最小请求，判定模型是否可用
async function probeModel(
	baseUrl: string,
	apiKey: string,
	model: string,
): Promise<{ ok: boolean; status: number; message: string }> {
	let url = (baseUrl || "").replace(/\/+$/, "");
	if (!/\/chat\/completions\/?$/i.test(url)) url = `${url}/chat/completions`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: "ping" }],
				stream: false,
				max_tokens: 5,
			}),
			signal: controller.signal,
		});
		const text = await res.text();
		if (res.status === 200) return { ok: true, status: 200, message: "" };
		let message = text.slice(0, 160);
		try {
			const j = JSON.parse(text);
			if (j?.error?.message) message = String(j.error.message).slice(0, 160);
		} catch {}
		return { ok: false, status: res.status, message };
	} catch (e) {
		return { ok: false, status: 0, message: String(e).slice(0, 160) };
	} finally {
		clearTimeout(timer);
	}
}

async function runProbe(db: D1, id: string): Promise<ProbeResult | null> {
	const channel = await getChannelById(db, id);
	if (!channel) return null;
	const ch = channel as unknown as {
		api_key?: string;
		base_url?: string;
		metadata_json?: string | null;
	};
	const tokenRows = await listCallTokens(db, { channelIds: [id] });
	const apiKey =
		tokenRows.length > 0
			? String(tokenRows[0].api_key ?? "")
			: String(ch.api_key ?? "");
	const provider = detectProvider(String(ch.base_url ?? ""));
	if (!apiKey) {
		return {
			probed_at: new Date().toISOString(),
			provider,
			available: [],
			unavailable: [
				{ model: "(无可用 Key)", status: 0, message: "渠道未配置 API Key" },
			],
		};
	}
	const candidates = CANDIDATE_MODELS[provider] ?? CANDIDATE_MODELS.generic;
	const available: string[] = [];
	const unavailable: ProbeUnavailable[] = [];
	for (const model of candidates) {
		const r = await probeModel(String(ch.base_url ?? ""), apiKey, model);
		if (r.ok) available.push(model);
		else unavailable.push({ model, status: r.status, message: r.message });
	}
	return { probed_at: new Date().toISOString(), provider, available, unavailable };
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
