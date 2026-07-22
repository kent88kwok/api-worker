import { Hono } from "hono";

// Worker 出口地理探测端点（GET /api/geo）
// 用于站点管理页显示当前 Worker 实际出口的国家/机房，并判断主流供应商是否受地区限制。
//
// 说明：api-worker 已关闭 Smart Placement（placement = "off"），Worker 在入站边缘节点
// (colo) 执行，其出站到上游（Gemini / OpenAI 等）的 IP 地理 ≈ 该 colo 地理，
// 即 request.cf.country。因此用 request.cf 反映出口地区是准确的。

// 主流供应商按地区限制清单（ISO 3166-1 alpha-2 国家代码）
// Gemini 不支持：中国大陆、俄罗斯、伊朗、朝鲜、叙利亚
const GEMINI_RESTRICTED = new Set(["CN", "RU", "IR", "KP", "SY"]);
// OpenAI / Anthropic 额外禁：白俄罗斯、缅甸、中非共和国等
const OPENAI_RESTRICTED = new Set([
	"CN", "RU", "IR", "KP", "SY", "BY", "MM", "CF",
]);

const app = new Hono();

app.get("/", async (c) => {
	const cf = (c.req.raw as Request & { cf?: Record<string, unknown> }).cf ?? {};
	const country = (cf.country as string) || null;
	const colo = (cf.colo as string) || null;
	const restricted = {
		gemini: country ? GEMINI_RESTRICTED.has(country) : null,
		openai: country ? OPENAI_RESTRICTED.has(country) : null,
		anthropic: country ? OPENAI_RESTRICTED.has(country) : null,
	};
	const geminiBlocked = country ? GEMINI_RESTRICTED.has(country) : false;
	return c.json({
		country,
		colo,
		city: (cf.city as string) || null,
		region: (cf.region as string) || null,
		timezone: (cf.timezone as string) || null,
		restricted,
		gemini_available: !geminiBlocked,
		note: geminiBlocked
			? "当前 Worker 出口位于 Gemini 不支持的地区，调用 Gemini 会返回 HTTP 400 User location is not supported。建议绑定到支持地区的自定义域，并确保 placement = off（关闭 Smart Placement）。"
			: "当前 Worker 出口地区 Gemini 可用。",
	});
});

export default app;
