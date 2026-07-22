import { useEffect, useState } from "hono/jsx/dom";
import { Card, Chip } from "../../components/ui";

type GeoInfo = {
	country: string | null;
	colo: string | null;
	city: string | null;
	region: string | null;
	timezone: string | null;
	restricted: {
		gemini: boolean | null;
		openai: boolean | null;
		anthropic: boolean | null;
	};
	gemini_available: boolean;
	note: string;
};

// 站点管理页顶部的“Worker 出口探测”面板。
// 自包含：进入页面即调用 GET /api/geo（该端点已对管理员免鉴权），
// 显示当前 Worker 出口国家/机房，以及对 Gemini / OpenAI / Anthropic 的地区限制情况。
export const GeoStatusPanel = () => {
	const [geo, setGeo] = useState<GeoInfo | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		fetch("/api/geo")
			.then((res) =>
				res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)),
			)
			.then((data: GeoInfo) => {
				if (active) setGeo(data);
			})
			.catch((err: unknown) => {
				if (active) {
					setError(err instanceof Error ? err.message : String(err));
				}
			});
		return () => {
			active = false;
		};
	}, []);

	return (
		<Card variant="compact" class="mb-4 space-y-2 p-4">
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-sm font-semibold">Worker 出口探测</span>
				{geo ? (
					<>
						<Chip
							variant={geo.gemini_available ? "success" : "danger"}
							class="text-xs"
						>
							出口 {geo.country || "未知"}
							{geo.colo ? ` · ${geo.colo}` : ""}
						</Chip>
						<Chip
							variant={geo.gemini_available ? "success" : "danger"}
							class="text-xs"
						>
							Gemini {geo.gemini_available ? "可用" : "受限 ❌"}
						</Chip>
						{geo.restricted.openai ? (
							<Chip variant="danger" class="text-xs">
								OpenAI 受限
							</Chip>
						) : null}
						{geo.restricted.anthropic ? (
							<Chip variant="danger" class="text-xs">
								Anthropic 受限
							</Chip>
						) : null}
					</>
				) : error ? (
					<Chip variant="muted" class="text-xs">
						探测失败：{error}
					</Chip>
				) : (
					<Chip variant="muted" class="text-xs">
						探测中…
					</Chip>
				)}
			</div>
			{geo?.note ? (
				<p class="text-xs text-[color:var(--app-ink-muted)]">{geo.note}</p>
			) : null}
			<p class="text-[11px] text-[color:var(--app-ink-muted)]">
				所有站点共用同一 Worker 出口，下方表格各站点的出口地区与此一致。
			</p>
		</Card>
	);
};
