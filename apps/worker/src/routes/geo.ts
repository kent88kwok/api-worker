import { Hono } from "hono";

// Worker 出口地理探测端点（GET /api/geo）
// 用于站点管理页显示当前 Worker 实际出口的国家/机房，并判断主流供应商是否受地区限制。
//
// 重要：request.cf.country 是「访客（浏览器）的来源国」，不是 Worker 的出口国！
// Worker 实际向 Gemini / OpenAI 发请求的出口 IP，地理上 ≈ 它运行的边缘机房（colo）所在国。
// 因此这里用一次「从 Worker 内部发起的子请求」来探测真实出口国：
//   子请求 egress 自当前 colo 的 IP 段 → 目标站点回显的 loc= 即为出口国。
// 若子请求失败，则用 colo → 国家 的兜底映射表。

// 主流供应商按地区限制清单（ISO 3166-1 alpha-2 国家代码）
// Gemini 不支持：中国大陆、俄罗斯、伊朗、朝鲜、叙利亚
const GEMINI_RESTRICTED = new Set(["CN", "RU", "IR", "KP", "SY"]);
// OpenAI / Anthropic 额外禁：白俄罗斯、缅甸、中非共和国等
const OPENAI_RESTRICTED = new Set([
	"CN",
	"RU",
	"IR",
	"KP",
	"SY",
	"BY",
	"MM",
	"CF",
]);

// colo → 国家 兜底映射（覆盖常见节点；子请求优先，此表仅兜底）
// 仅列部分，更多见 https://www.cloudflare.com/network/
const COLO_COUNTRY: Record<string, string> = {
	AMS: "NL", // Amsterdam, Netherlands
	DNR: "DE", // Düsseldorf, Germany
	FRA: "DE", // Frankfurt, Germany
	BER: "DE", // Berlin, Germany
	MUC: "DE", // Munich, Germany
	HAM: "DE", // Hamburg, Germany
	LHR: "GB", // London, UK
	LCY: "GB", // London (City), UK
	MAN: "GB", // Manchester, UK
	CDG: "FR", // Paris, France
	MRS: "FR", // Marseille, France
	ORY: "FR", // Paris (Orly), France
	MAD: "ES", // Madrid, Spain
	BCN: "ES", // Barcelona, Spain
	LIS: "PT", // Lisbon, Portugal
	MIL: "IT", // Milan, Italy
	FCO: "IT", // Rome, Italy
	ARN: "SE", // Stockholm, Sweden
	OSL: "NO", // Oslo, Norway
	CPH: "DK", // Copenhagen, Denmark
	HEL: "FI", // Helsinki, Finland
	VIE: "AT", // Vienna, Austria
	ZRH: "CH", // Zurich, Switzerland
	BRU: "BE", // Brussels, Belgium
	DUB: "IE", // Dublin, Ireland
	WAW: "PL", // Warsaw, Poland
	PRG: "CZ", // Prague, Czechia
	BUD: "HU", // Budapest, Hungary
	OTP: "RO", // Bucharest, Romania
	ATH: "GR", // Athens, Greece
	IST: "TR", // Istanbul, Turkey
	SVO: "RU", // Moscow, Russia（受限）
	LED: "RU", // St. Petersburg, Russia（受限）
	KIV: "MD", // Chisinau, Moldova
	// 北美
	SJC: "US", // San Jose
	LAX: "US", // Los Angeles
	SFO: "US", // San Francisco
	SEA: "US", // Seattle
	ORD: "US", // Chicago
	IAD: "US", // Washington DC
	DFW: "US", // Dallas
	ATL: "US", // Atlanta
	MIA: "US", // Miami
	BOS: "US", // Boston
	YYZ: "CA", // Toronto, Canada
	YVR: "CA", // Vancouver, Canada
	YUL: "CA", // Montreal, Canada
	// 亚太
	NRT: "JP", // Tokyo, Japan
	HND: "JP", // Tokyo Haneda, Japan
	KIX: "JP", // Osaka, Japan
	ICN: "KR", // Seoul, Korea
	HKG: "HK", // Hong Kong
	TPE: "TW", // Taipei
	SIN: "SG", // Singapore
	SYD: "AU", // Sydney, Australia
	MEL: "AU", // Melbourne, Australia
	BNE: "AU", // Brisbane, Australia
	BOM: "IN", // Mumbai, India
	DEL: "IN", // Delhi, India
	BLR: "IN", // Bangalore, India
	// 南美
	GRU: "BR", // São Paulo, Brazil
	GIG: "BR", // Rio de Janeiro, Brazil
	EZE: "AR", // Buenos Aires, Argentina
	SCL: "CL", // Santiago, Chile
	BOG: "CO", // Bogotá, Colombia
	// 中东/非洲
	DXB: "AE", // Dubai, UAE
	JNB: "ZA", // Johannesburg, South Africa
	CAI: "EG", // Cairo, Egypt
	TLV: "IL", // Tel Aviv, Israel
	// 受限区（colo 落到这些国家即受限）
	PEK: "CN", // Beijing
	PVG: "CN", // Shanghai
	CAN: "CN", // Guangzhou
	CTU: "CN", // Chengdu
	RUH: "SA", // Riyadh, Saudi Arabia
};

// 从 Worker 内部子请求探测真实出口国（egress IP 地理）
async function probeEgressCountry(): Promise<string | null> {
	try {
		// cloudflare 的 /cdn-cgi/trace 会回显请求来源 IP 的国家（loc=）
		// 该子请求从当前 colo egress，所以 loc= 即 Worker 出口国
		const res = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
			cf: { cacheTtl: 60 } as RequestInit["cf"],
		});
		const text = await res.text();
		const m = text.match(/loc=([A-Z]{2})/);
		if (m && m[1]) return m[1];
	} catch {
		// 子请求失败时回退到 colo 映射
	}
	return null;
}

const app = new Hono();

app.get("/", async (c) => {
	const cf = (c.req.raw as Request & { cf?: Record<string, unknown> }).cf ?? {};
	// 访客（浏览器）来源国 —— 仅展示，不用于限制判断
	const visitorCountry = (cf.country as string) || null;
	const colo = (cf.colo as string) || null;

	// 真实出口国：优先子请求探测，失败则用 colo 映射兜底
	const egressCountry =
		(await probeEgressCountry()) || (colo ? COLO_COUNTRY[colo] || null : null);

	const restricted = {
		gemini: egressCountry ? GEMINI_RESTRICTED.has(egressCountry) : null,
		openai: egressCountry ? OPENAI_RESTRICTED.has(egressCountry) : null,
		anthropic: egressCountry ? OPENAI_RESTRICTED.has(egressCountry) : null,
	};
	const geminiBlocked = egressCountry ? GEMINI_RESTRICTED.has(egressCountry) : false;

	return c.json({
		visitor_country: visitorCountry, // 访客来源国（你的浏览器所在国）
		egress_country: egressCountry, // Worker 真实出口国（决定 Gemini 是否受限）
		colo,
		city: (cf.city as string) || null,
		region: (cf.region as string) || null,
		timezone: (cf.timezone as string) || null,
		restricted,
		gemini_available: !geminiBlocked,
		note: geminiBlocked
			? `当前 Worker 出口位于 Gemini 不支持的地区（${egressCountry}），调用 Gemini 会返回 HTTP 400 User location is not supported。建议确认绑定到支持地区的自定义域，并确保 placement = off（关闭 Smart Placement）。（访客来源国 ${visitorCountry} 不影响此判断）`
			: `当前 Worker 出口地区（${egressCountry}）Gemini 可用。注意：上方“访客来源国 ${visitorCountry}”只是你浏览器的所在国，不影响 Gemini 的地区限制判断。`,
	});
});

export default app;
