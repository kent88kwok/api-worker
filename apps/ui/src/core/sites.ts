import {
	getRequestEntryFormatLabel as getSharedRequestEntryFormatLabel,
	getSiteTypeLabel,
	supportsSiteCheckin,
} from "../../../shared-core/src";
import type {
	RequestEntryFormat,
	Site,
	SiteChannelRefreshItem,
	SiteVerificationBatchSummary,
	SiteVerificationResult,
	VerificationVerdict,
	VerificationStageStatus,
} from "./types";
import { getBeijingDateString } from "./utils";

export { getSiteTypeLabel };

export type SiteSortKey =
	| "name"
	| "type"
	| "status"
	| "weight"
	| "tokens"
	| "cooldowns"
	| "checkin_enabled"
	| "checkin";

export type SiteSortDirection = "asc" | "desc";

export type SiteSortState = {
	key: SiteSortKey;
	direction: SiteSortDirection;
};

export const getSiteStatusLabel = (status: string) =>
	status === "active" ? "启用" : "禁用";

export const getSiteCoolingModelCount = (site: Site) =>
	Number(site.cooling_model_count ?? site.cooling_models?.length ?? 0);

export const getSiteCoolingMaxRemainingSeconds = (site: Site) =>
	Number(
		site.cooling_max_remaining_seconds ??
			Math.max(
				0,
				...(site.cooling_models ?? []).map((item) =>
					Number(item.remaining_seconds ?? 0),
				),
			),
	);

export const getVerificationStageTone = (status: VerificationStageStatus) => {
	if (status === "pass") {
		return "success";
	}
	if (status === "warn") {
		return "warning";
	}
	if (status === "fail") {
		return "danger";
	}
	return "muted";
};

export const getVerificationVerdictLabel = (verdict: VerificationVerdict) => {
	if (verdict === "serving") {
		return "可服务";
	}
	if (verdict === "degraded") {
		return "部分异常";
	}
	if (verdict === "recoverable") {
		return "可恢复";
	}
	if (verdict === "not_recoverable") {
		return "暂不可恢复";
	}
	return "不可服务";
};

export const getSuggestedActionLabel = (action: string) => {
	if (action === "fix_credentials") {
		return "检查站点或调用令牌";
	}
	if (action === "fix_endpoint") {
		return "检查站点地址与 endpoint 配置";
	}
	if (action === "fix_model_config") {
		return "补充模型配置或模型映射";
	}
	if (action === "retry") {
		return "稍后重试";
	}
	if (action === "manual_review") {
		return "需要人工排查";
	}
	return "无需额外处理";
};

export const getPrimaryVerificationIssue = (result: SiteVerificationResult) => {
	if (result.stages.service.status === "fail") {
		return result.stages.service.message;
	}
	if (result.stages.capability.status === "fail") {
		return result.stages.capability.message;
	}
	if (result.stages.connectivity.status === "fail") {
		return result.stages.connectivity.message;
	}
	if (result.stages.recovery.status === "fail") {
		return result.stages.recovery.message;
	}
	if (result.stages.capability.status === "warn") {
		return result.stages.capability.message;
	}
	return result.message;
};

export const getVerificationFailedTokenIssues = (
	result: SiteVerificationResult,
) =>
	(result.token_results ?? [])
		.filter((item) => !item.ok)
		.map((item) => {
			const tokenLabel =
				String(item.tokenName ?? "").trim() ||
				String(item.tokenId ?? "").trim() ||
				"主调用令牌";
			const statusLabel =
				item.httpStatus === null || item.httpStatus === undefined
					? "请求失败"
					: `HTTP ${item.httpStatus}`;
			const detail = String(item.detail ?? "").trim();
			return detail
				? `${tokenLabel}：${statusLabel} | ${detail}`
				: `${tokenLabel}：${statusLabel}`;
		});

export const getVerificationAttemptedModels = (
	result: SiteVerificationResult,
) =>
	(result.tried_models ?? [])
		.map((item) => String(item ?? "").trim())
		.filter(Boolean);

export const getVerificationAttemptedFormats = (
	result: SiteVerificationResult,
) =>
	(result.tried_request_formats ?? []).filter(
		(item): item is RequestEntryFormat => Boolean(item),
	);

export const getVerificationAttempts = (result: SiteVerificationResult) =>
	(result.attempts ?? []).filter((item) => Boolean(item));

export const getVerificationAttemptStatusLabel = (
	status: SiteVerificationResult["attempts"][number]["status"],
) => (status === "success" ? "成功" : "失败");

export const getVerificationAttemptSummary = (
	result: SiteVerificationResult,
) => {
	const models = getVerificationAttemptedModels(result);
	const formats = getVerificationAttemptedFormats(result).map((format) =>
		getRequestEntryFormatLabel(format),
	);
	return {
		models,
		formats,
	};
};

const splitRefreshTokenLabels = (value: string | null | undefined) =>
	String(value ?? "")
		.split("、")
		.map((item) => item.trim())
		.filter(Boolean);

const isLikelyHtmlPayload = (value: string) =>
	/<!doctype\s+html/i.test(value) ||
	/<html[\s>]/i.test(value) ||
	/<head[\s>]/i.test(value) ||
	/<body[\s>]/i.test(value);

const summarizeHtmlFailureDetail = (html: string) => {
	const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? "";
	const headline = html.match(/<h1[^>]*>([^<]+)<\/h1>/i)?.[1]?.trim() ?? "";
	const server =
		html
			.match(/<center>([^<]+)<\/center>\s*(?:<script|<\/body|<\/html)/i)?.[1]
			?.trim() ?? "";
	const primary = headline || title;
	if (primary && server && primary !== server) {
		return `${primary} | ${server}`;
	}
	if (primary || server) {
		return primary || server;
	}
	return "未找到失败原因";
};

const stripReferenceSuffix = (value: string) =>
	value
		.replace(/\s*[;,]?\s*reference\s*=\s*[A-Za-z0-9_-]+/giu, "")
		.replace(/\s*[;,]\s*$/u, "")
		.trim();

const normalizeRefreshFailureReason = (value: string) => {
	const normalized = String(value ?? "")
		.replace(/\s+/gu, " ")
		.trim();
	if (!normalized) {
		return "未找到失败原因";
	}
	if (isLikelyHtmlPayload(normalized)) {
		return summarizeHtmlFailureDetail(normalized);
	}
	return stripReferenceSuffix(normalized) || "未找到失败原因";
};

export type RefreshFailureDetail = {
	tokens: string[];
	code: string;
	reason: string;
};

export const getRefreshFailedTokenLabels = (item: SiteChannelRefreshItem) => {
	const direct = (item.failed_tokens ?? [])
		.map((token) => String(token ?? "").trim())
		.filter(Boolean);
	if (direct.length > 0) {
		return Array.from(new Set(direct));
	}
	return Array.from(
		new Set(
			String(item.detail_message ?? "")
				.split("；")
				.map((entry) => entry.trim())
				.filter(Boolean)
				.flatMap((entry) => {
					const separatorIndex = entry.indexOf("：");
					if (separatorIndex < 0) {
						return [];
					}
					return splitRefreshTokenLabels(entry.slice(0, separatorIndex));
				}),
		),
	);
};

export const getRefreshSuccessfulTokenLabels = (item: SiteChannelRefreshItem) =>
	Array.from(
		new Set(
			(item.successful_tokens ?? [])
				.map((token) => String(token ?? "").trim())
				.filter(Boolean),
		),
	);

export const getRefreshFailureDetails = (
	item: SiteChannelRefreshItem,
): RefreshFailureDetail[] => {
	const directGroups = (item.failure_groups ?? []).filter(
		(group) =>
			Array.isArray(group.tokens) &&
			typeof group.code === "string" &&
			typeof group.reason === "string",
	);
	if (directGroups.length > 0) {
		return directGroups.map((group) => ({
			tokens: group.tokens
				.map((token) => String(token ?? "").trim())
				.filter(Boolean),
			code: String(group.code ?? "").trim() || "请求失败",
			reason: String(group.reason ?? "").trim() || "未找到失败原因",
		}));
	}
	const details = String(item.detail_message ?? "")
		.split("；")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (details.length === 0) {
		return [];
	}
	return Array.from(
		new Set(
			details.map((entry) => {
				const separatorIndex = entry.indexOf("：");
				const tokens =
					separatorIndex < 0
						? []
						: splitRefreshTokenLabels(entry.slice(0, separatorIndex));
				const rawReason =
					separatorIndex < 0
						? entry
						: entry.slice(separatorIndex + 1).trim() || entry;
				const codeMatch = rawReason.match(/HTTP\s+([A-Za-z0-9_-]+)/iu);
				const code = codeMatch?.[1] ? codeMatch[1] : "请求失败";
				const normalizedReason = normalizeRefreshFailureReason(
					rawReason.replace(/^HTTP\s+[A-Za-z0-9_-]+\s*\|\s*/iu, "").trim(),
				);
				const reason =
					!normalizedReason ||
					normalizedReason.toLowerCase() ===
						`error code: ${code.toLowerCase()}` ||
					normalizedReason.toLowerCase() === code.toLowerCase()
						? "未找到失败原因"
						: normalizedReason;
				return JSON.stringify({ tokens, code, reason });
			}),
		),
	).map((detail) => JSON.parse(detail) as RefreshFailureDetail);
};

export const getVerificationSeverityRank = (verdict: VerificationVerdict) => {
	if (verdict === "degraded" || verdict === "recoverable") {
		return 1;
	}
	if (verdict === "failed" || verdict === "not_recoverable") {
		return 2;
	}
	return 0;
};

export const getVerificationSeverityLabel = (verdict: VerificationVerdict) => {
	if (verdict === "degraded") {
		return "轻微";
	}
	if (verdict === "recoverable") {
		return "可恢复";
	}
	if (verdict === "not_recoverable") {
		return "未恢复";
	}
	if (verdict === "failed") {
		return "严重";
	}
	return "正常";
};

export type RecoveryCleanupGroup = {
	id: string;
	title: string;
	detail: string | null;
	evidence: string[];
	items: SiteVerificationResult[];
};

type RecoveryFailureStageKey =
	| "connectivity"
	| "capability"
	| "service"
	| "recovery";

const recoveryFailureStageOrder: RecoveryFailureStageKey[] = [
	"service",
	"connectivity",
	"capability",
	"recovery",
];

const recoveryFailureStageLabels: Record<RecoveryFailureStageKey, string> = {
	connectivity: "连接验证",
	capability: "能力验证",
	service: "服务验证",
	recovery: "恢复评估",
};

const normalizeCleanupSignatureText = (
	value: string | number | null | undefined,
) =>
	String(value ?? "")
		.replace(/\s+/gu, " ")
		.trim();

const normalizeCleanupKeyPart = (value: string | number | null | undefined) =>
	normalizeCleanupSignatureText(value)
		.toLowerCase()
		.replace(/[^a-z0-9_\u4e00-\u9fa5]+/giu, "-")
		.replace(/^-+|-+$/gu, "") || "unknown";

const getPrimaryRecoveryFailureStage = (
	result: SiteVerificationResult,
): [
	RecoveryFailureStageKey,
	SiteVerificationResult["stages"][RecoveryFailureStageKey],
] => {
	const stageKey =
		recoveryFailureStageOrder.find(
			(key) => result.stages[key].status === "fail",
		) ?? "recovery";
	return [stageKey, result.stages[stageKey]];
};

const getLastFailedVerificationAttempt = (result: SiteVerificationResult) =>
	[...getVerificationAttempts(result)]
		.reverse()
		.find((attempt) => attempt.status === "failed") ?? null;

const appendUniqueCleanupEvidence = (
	target: string[],
	value: string | null,
) => {
	const normalized = normalizeCleanupSignatureText(value);
	if (!normalized || target.includes(normalized)) {
		return;
	}
	target.push(normalized);
};

export const buildRecoveryCleanupGroups = (
	items: SiteVerificationResult[],
): RecoveryCleanupGroup[] => {
	const groups = new Map<string, RecoveryCleanupGroup>();
	for (const item of items) {
		if (item.verdict === "recoverable") {
			continue;
		}
		const [stageKey, stage] = getPrimaryRecoveryFailureStage(item);
		const failedAttempt = getLastFailedVerificationAttempt(item);
		const httpStatus =
			item.trace.upstream_status ?? failedAttempt?.http_status ?? null;
		const detailCode =
			normalizeCleanupSignatureText(item.trace.detail_code) ||
			normalizeCleanupSignatureText(failedAttempt?.detail_code) ||
			normalizeCleanupSignatureText(stage.code) ||
			"unknown_error";
		const stageCode =
			normalizeCleanupSignatureText(stage.code) ||
			detailCode ||
			"unknown_error";
		const detail =
			normalizeCleanupSignatureText(item.trace.detail_message) ||
			normalizeCleanupSignatureText(failedAttempt?.detail_message) ||
			normalizeCleanupSignatureText(stage.message) ||
			null;
		const id = [
			stageKey,
			stageCode,
			httpStatus ?? "-",
			detailCode,
			detail ?? "-",
		]
			.map((part) => normalizeCleanupKeyPart(part))
			.join(":");
		const evidence: string[] = [];
		if (httpStatus !== null && httpStatus !== undefined) {
			appendUniqueCleanupEvidence(evidence, `HTTP ${httpStatus}`);
		}
		appendUniqueCleanupEvidence(evidence, detailCode);
		appendUniqueCleanupEvidence(evidence, stageCode);
		const titleParts = [
			recoveryFailureStageLabels[stageKey],
			stageCode,
			httpStatus !== null && httpStatus !== undefined
				? `HTTP ${httpStatus}`
				: null,
		].filter((part): part is string => Boolean(part));
		const current = groups.get(id);
		if (current) {
			current.items.push(item);
			continue;
		}
		groups.set(id, {
			id,
			title: titleParts.join(" · "),
			detail,
			evidence,
			items: [item],
		});
	}
	return Array.from(groups.values());
};

export const summarizeVerificationResults = (
	items: SiteVerificationResult[],
): SiteVerificationBatchSummary => {
	return items.reduce(
		(acc, item) => {
			acc.total += 1;
			if (item.verdict === "serving") {
				acc.serving += 1;
			} else if (item.verdict === "degraded") {
				acc.degraded += 1;
			} else if (item.verdict === "recoverable") {
				acc.recoverable += 1;
			} else if (item.verdict === "not_recoverable") {
				acc.not_recoverable += 1;
			} else {
				acc.failed += 1;
			}
			return acc;
		},
		{
			total: 0,
			serving: 0,
			degraded: 0,
			failed: 0,
			recoverable: 0,
			not_recoverable: 0,
			skipped: 0,
		} satisfies SiteVerificationBatchSummary,
	);
};

export const getSiteCheckinLabel = (site: Site, today?: string) => {
	const shouldShow =
		supportsSiteCheckin(site.site_type) && Boolean(site.checkin_enabled);
	if (!shouldShow) {
		return "-";
	}
	const day = today ?? getBeijingDateString();
	const isToday = site.last_checkin_date === day;
	const status = isToday ? site.last_checkin_status : null;
	if (!status) {
		return "未签到";
	}
	if (status === "success") {
		return "成功";
	}
	if (status === "skipped") {
		return "已签";
	}
	return "签到失败";
};

export const getRequestEntryFormatLabel = (format: RequestEntryFormat) =>
	getSharedRequestEntryFormatLabel(format);

export const formatSiteRequestEntrySummary = (site: Site) => {
	const path = String(site.request_entry_path ?? "").trim();
	const format = site.request_entry_format ?? null;
	if (!path && !format) {
		return null;
	}
	const pathLabel = path || "默认端点";
	return `${pathLabel} · ${format ? getRequestEntryFormatLabel(format) : "自动"}`;
};

export const filterSites = (sites: Site[], query: string) => {
	const keyword = query.trim().toLowerCase();
	if (!keyword) {
		return sites;
	}
	return sites.filter((site) => {
		const name = String(site.name ?? "").toLowerCase();
		const url = String(site.base_url ?? "").toLowerCase();
		return name.includes(keyword) || url.includes(keyword);
	});
};

const toSortableText = (value: string) => value.trim().toLowerCase();

const getSortValue = (site: Site, key: SiteSortKey, today: string) => {
	switch (key) {
		case "name":
			return String(site.name ?? "");
		case "type":
			return getSiteTypeLabel(site.site_type);
		case "status":
			return getSiteStatusLabel(site.status);
		case "weight":
			return Number(site.weight ?? 0);
		case "tokens":
			return Number(site.call_tokens?.length ?? 0);
		case "cooldowns":
			return (
				getSiteCoolingModelCount(site) * 1_000_000 +
				getSiteCoolingMaxRemainingSeconds(site)
			);
		case "checkin_enabled":
			return supportsSiteCheckin(site.site_type)
				? site.checkin_enabled
					? "已开启"
					: "已关闭"
				: "-";
		case "checkin":
			return getSiteCheckinLabel(site, today);
		default:
			return "";
	}
};

export const sortSites = (sites: Site[], sort: SiteSortState) => {
	const today = getBeijingDateString();
	const items = sites.map((site, index) => {
		const raw = getSortValue(site, sort.key, today);
		const value =
			typeof raw === "number" ? raw : toSortableText(String(raw ?? ""));
		return { site, index, value };
	});
	items.sort((left, right) => {
		if (left.value === right.value) {
			return left.index - right.index;
		}
		if (typeof left.value === "number" && typeof right.value === "number") {
			return sort.direction === "asc"
				? left.value - right.value
				: right.value - left.value;
		}
		const comparison = String(left.value).localeCompare(String(right.value));
		return sort.direction === "asc" ? comparison : -comparison;
	});
	return items.map((item) => item.site);
};
