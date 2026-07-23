import type { D1Database } from "@cloudflare/workers-types";
import { Hono } from "hono";
import {
	getDefaultBaseUrlForSiteType,
	normalizeRequestEntryFormat,
	normalizeSiteType,
	supportsSiteCheckin,
	type SiteType,
} from "../../../shared-core/src";
import type { AppEnv } from "../env";
import {
	listCallTokens,
	replaceCallTokensForChannel,
} from "../domains/channel/call-token-repo";
import {
	clearChannelModelCooldown,
	listCoolingDownModelEntriesByChannel,
} from "../domains/channel/model-capabilities";
import {
	deleteChannel,
	getChannelById,
	insertChannel,
	listChannels,
	updateChannel,
} from "../domains/channel/repo";
import { invalidateSelectionHotCache } from "../services/hot-kv";
import {
	buildSiteMetadata,
	parseSiteMetadata,
	type RequestEntryFormat,
} from "../domains/site/metadata";
import {
	recoverDisabledChannelsViaWorker,
	refreshActiveChannelsViaWorker,
	refreshChannelById,
	previewRefreshChannelById,
	runCheckinAllViaWorker,
	runCheckinSingleViaWorker,
	verifyChannelById,
	verifySitesByIds,
} from "../domains/site/task-dispatcher";
import { triggerBackupAfterDataChange } from "../domains/backup/auto-sync";
import { generateToken } from "../utils/crypto";
import { jsonError } from "../utils/http";
import { nowIso } from "../utils/time";
import { normalizeBaseUrl } from "../utils/url";
import {
	buildVerificationBatchResult,
	parseSiteVerificationSummary,
	type SiteVerificationBatchResult,
	type SiteVerificationResult,
} from "../domains/site/verification";
import {
	normalizeCallTokens,
	type NormalizedSiteCallToken,
	type SiteCallTokenInput,
} from "../domains/site/call-token-order";
import {
	listSiteTaskReports,
	saveSiteTaskReport,
	type SiteChannelRefreshBatchReport,
	type SiteTaskKind,
	type SiteTaskProgress,
	type SiteTaskReportState,
} from "../domains/site/task-report-store";
import { getProxyRuntimeSettings } from "../domains/settings";

const sites = new Hono<AppEnv>();

type SitePayload = {
	name?: string;
	base_url?: string;
	weight?: number;
	status?: string;
	site_type?: SiteType;
	request_entry_path?: string | null;
	request_entry_format?: string | null;
	manual_include_models?: unknown;
	manual_exclude_models?: unknown;
	probe_concurrency?: unknown;
	probe_delay_ms?: unknown;
	checkin_url?: string | null;
	system_token?: string;
	system_userid?: string;
	checkin_enabled?: boolean;
	call_tokens?: CallTokenPayload[];
	api_key?: string;
	checkin_token?: string;
	checkin_userid?: string;
	checkin_status?: string;
};

type CallTokenPayload = SiteCallTokenInput & {
	id?: string;
};

type CheckinTaskItem = {
	id: string;
	name: string;
	status: "success" | "failed" | "skipped";
	message: string;
	checkin_date?: string | null;
};

const parseSiteType = (value: unknown): SiteType => {
	return normalizeSiteType(value);
};

const trimValue = (value: unknown): string => {
	if (typeof value !== "string") {
		return "";
	}
	return value.trim();
};

const resolveBaseUrl = (siteType: SiteType, raw: unknown): string => {
	const trimmed = trimValue(raw);
	if (trimmed) {
		return normalizeBaseUrl(trimmed);
	}
	const fallback = getDefaultBaseUrlForSiteType(siteType);
	if (fallback) {
		return normalizeBaseUrl(fallback);
	}
	return "";
};

const parseBoolean = (value: unknown, fallback = false): boolean => {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return value.toLowerCase() === "true";
	}
	return fallback;
};

const buildEmptySiteTaskProgress = (
	total: number,
	updatedAt: string,
): SiteTaskProgress => ({
	total,
	completed: 0,
	success: 0,
	warning: 0,
	failed: 0,
	skipped: 0,
	current_site_id: null,
	current_site_name: null,
	updated_at: updatedAt,
});

const summarizeCheckinItems = (
	items: Array<{ status: "success" | "failed" | "skipped" }>,
) => ({
	total: items.length,
	success: items.filter((item) => item.status === "success").length,
	failed: items.filter((item) => item.status === "failed").length,
	skipped: items.filter((item) => item.status === "skipped").length,
});

const summarizeRefreshItems = (
	items: SiteChannelRefreshBatchReport["items"],
	total: number,
): SiteChannelRefreshBatchReport["summary"] => {
	const success = items.filter((item) => item.status === "success").length;
	const warning = items.filter((item) => item.status === "warning").length;
	return {
		total,
		success,
		warning,
		failed: items.filter((item) => item.status === "failed").length,
	};
};

const summarizeVerificationItems = (
	items: SiteVerificationResult[],
	total: number,
): SiteVerificationBatchResult["summary"] => {
	const summary = {
		total,
		serving: 0,
		degraded: 0,
		failed: 0,
		recoverable: 0,
		not_recoverable: 0,
		skipped: 0,
	};
	for (const item of items) {
		if (item.verdict === "serving") {
			summary.serving += 1;
			continue;
		}
		if (item.verdict === "degraded") {
			summary.degraded += 1;
			continue;
		}
		if (item.verdict === "recoverable") {
			summary.recoverable += 1;
			continue;
		}
		if (item.verdict === "not_recoverable") {
			summary.not_recoverable += 1;
			continue;
		}
		summary.failed += 1;
	}
	return summary;
};

const buildVerificationTaskProgress = (
	kind: "verify-active" | "verify-disabled",
	items: SiteVerificationResult[],
	total: number,
	updatedAt: string,
	current?: {
		id?: string | null;
		name?: string | null;
	},
): SiteTaskProgress => {
	const summary = summarizeVerificationItems(items, total);
	return {
		total,
		completed: items.length,
		success: kind === "verify-active" ? summary.serving : summary.recoverable,
		warning: kind === "verify-active" ? summary.degraded : 0,
		failed:
			kind === "verify-active"
				? summary.failed
				: summary.not_recoverable + summary.failed,
		skipped: summary.skipped,
		current_site_id: current?.id ?? null,
		current_site_name: current?.name ?? null,
		updated_at: updatedAt,
	};
};

const buildRefreshTaskProgress = (
	items: SiteChannelRefreshBatchReport["items"],
	total: number,
	updatedAt: string,
	current?: {
		id?: string | null;
		name?: string | null;
	},
): SiteTaskProgress => ({
	total,
	completed: items.length,
	success: items.filter((item) => item.status === "success").length,
	warning: items.filter((item) => item.status === "warning").length,
	failed: items.filter((item) => item.status === "failed").length,
	skipped: 0,
	current_site_id: current?.id ?? null,
	current_site_name: current?.name ?? null,
	updated_at: updatedAt,
});

const buildCheckinTaskProgress = (
	items: CheckinTaskItem[],
	total: number,
	updatedAt: string,
	current?: {
		id?: string | null;
		name?: string | null;
	},
): SiteTaskProgress => {
	const summary = summarizeCheckinItems(items);
	return {
		total,
		completed: items.length,
		success: summary.success,
		warning: 0,
		failed: summary.failed,
		skipped: summary.skipped,
		current_site_id: current?.id ?? null,
		current_site_name: current?.name ?? null,
		updated_at: updatedAt,
	};
};

const buildRunningCheckinTaskReport = (
	startedAt: string,
	total: number,
	items: CheckinTaskItem[] = [],
): SiteTaskReportState => ({
	kind: "checkin",
	status: "running",
	runs_at: startedAt,
	started_at: startedAt,
	finished_at: null,
	progress: buildCheckinTaskProgress(items, total, startedAt),
	error_message: null,
	summary: summarizeCheckinItems(items),
	items,
});

const buildRunningVerificationTaskReport = (
	kind: "verify-active" | "verify-disabled",
	startedAt: string,
	total: number,
	items: SiteVerificationResult[] = [],
): SiteTaskReportState => {
	const report = {
		summary: summarizeVerificationItems(items, total),
		items,
		runs_at: startedAt,
	};
	return {
		kind,
		status: "running",
		runs_at: startedAt,
		started_at: startedAt,
		finished_at: null,
		progress: buildVerificationTaskProgress(kind, items, total, startedAt),
		error_message: null,
		report: {
			...report,
		},
	};
};

const buildRunningRefreshTaskReport = (
	startedAt: string,
	total: number,
	items: SiteChannelRefreshBatchReport["items"] = [],
): SiteTaskReportState => ({
	kind: "refresh-active",
	status: "running",
	runs_at: startedAt,
	started_at: startedAt,
	finished_at: null,
	progress: buildRefreshTaskProgress(items, total, startedAt),
	error_message: null,
	report: {
		summary: summarizeRefreshItems(items, total),
		items,
		runs_at: startedAt,
	},
});

const buildCompletedCheckinTaskReport = (
	startedAt: string,
	finishedAt: string,
	items: CheckinTaskItem[],
): SiteTaskReportState => ({
	kind: "checkin",
	status: "completed",
	runs_at: finishedAt,
	started_at: startedAt,
	finished_at: finishedAt,
	progress: buildCheckinTaskProgress(items, items.length, finishedAt),
	error_message: null,
	summary: summarizeCheckinItems(items),
	items,
});

const buildCompletedVerificationTaskReport = (
	kind: "verify-active" | "verify-disabled",
	startedAt: string,
	report: SiteVerificationBatchResult,
): SiteTaskReportState => ({
	kind,
	status: "completed",
	runs_at: report.runs_at,
	started_at: startedAt,
	finished_at: report.runs_at,
	progress: buildVerificationTaskProgress(
		kind,
		report.items,
		report.summary.total,
		report.runs_at,
	),
	error_message: null,
	report,
});

const buildCompletedRefreshTaskReport = (
	startedAt: string,
	report: SiteChannelRefreshBatchReport,
): SiteTaskReportState => ({
	kind: "refresh-active",
	status: "completed",
	runs_at: report.runs_at,
	started_at: startedAt,
	finished_at: report.runs_at,
	progress: buildRefreshTaskProgress(
		report.items,
		report.summary.total,
		report.runs_at,
	),
	error_message: null,
	report,
});

const buildFailedTaskReport = (
	report: SiteTaskReportState,
	finishedAt: string,
	message: string,
): SiteTaskReportState => ({
	...report,
	status: "failed",
	runs_at: finishedAt,
	finished_at: finishedAt,
	error_message: message,
	progress: {
		...report.progress,
		current_site_id: null,
		current_site_name: null,
		updated_at: finishedAt,
	},
});

const hasRunningTaskReport = async (db: D1Database, kind: SiteTaskKind) => {
	const reports = await listSiteTaskReports(db);
	const current = reports[kind];
	return current?.status === "running";
};

const toCallTokenRows = (
	channelId: string,
	tokens: NormalizedSiteCallToken[],
	now: string,
) =>
	tokens.map((token) => ({
		id: generateToken("ct_"),
		channel_id: channelId,
		name: token.name,
		api_key: token.api_key,
		priority: token.priority,
		created_at: now,
		updated_at: now,
	}));

const buildSiteRecord = (
	channel: {
		id: string;
		name: string;
		base_url: string;
		api_key: string;
		weight: number;
		status: string;
		system_token?: string | null;
		system_userid?: string | null;
		checkin_enabled?: number | boolean | null;
		checkin_url?: string | null;
		last_checkin_date?: string | null;
		last_checkin_status?: string | null;
		last_checkin_message?: string | null;
		last_checkin_at?: string | null;
		metadata_json?: string | null;
		created_at?: string | null;
		updated_at?: string | null;
	},
	callTokens: Array<{
		id: string;
		name: string;
		api_key: string;
		priority?: number | null;
	}>,
	coolingModels: Array<{
		model: string;
		last_err_at: number;
		last_err_code: string | null;
		last_err_count: number;
		cooldown_count: number;
		remaining_seconds: number;
	}>,
) => {
	const metadata = parseSiteMetadata(channel.metadata_json);
	const rawEnabled = channel.checkin_enabled ?? 0;
	const checkinEnabled =
		typeof rawEnabled === "boolean" ? rawEnabled : Number(rawEnabled) === 1;
	const cooldownMaxRemainingSeconds = coolingModels.reduce(
		(max, item) => Math.max(max, Number(item.remaining_seconds ?? 0)),
		0,
	);
	return {
		id: channel.id,
		name: channel.name,
		base_url: channel.base_url,
		weight: Number(channel.weight ?? 1),
		status: channel.status,
		site_type: metadata.site_type,
		api_key: channel.api_key,
		system_token: channel.system_token ?? null,
		system_userid: channel.system_userid ?? null,
		checkin_enabled: checkinEnabled,
		checkin_id: null,
		checkin_url: channel.checkin_url ?? null,
		call_tokens: callTokens,
		last_checkin_date: channel.last_checkin_date ?? null,
		last_checkin_status: channel.last_checkin_status ?? null,
		last_checkin_message: channel.last_checkin_message ?? null,
		last_checkin_at: channel.last_checkin_at ?? null,
		verification: parseSiteVerificationSummary(channel.metadata_json),
		request_entry_path: metadata.request_entry.path,
		request_entry_format: metadata.request_entry.format,
		manual_include_models: metadata.manual_include_models,
		manual_exclude_models: metadata.manual_exclude_models,
		probe_concurrency: metadata.probe_concurrency,
		probe_delay_ms: metadata.probe_delay_ms,
		cooling_models: coolingModels,
		cooling_model_count: coolingModels.length,
		cooling_max_remaining_seconds: cooldownMaxRemainingSeconds,
		created_at: channel.created_at ?? null,
		updated_at: channel.updated_at ?? null,
	};
};

sites.get("/", async (c) => {
	const channels = await listChannels(c.env.DB, {
		orderBy: "created_at",
		order: "DESC",
	});
	const channelIds = channels.map((channel) => channel.id);
	const runtimeSettings = await getProxyRuntimeSettings(c.env.DB);
	const coolingModelMap = await listCoolingDownModelEntriesByChannel(
		c.env.DB,
		channelIds,
		Math.max(0, Math.floor(runtimeSettings.model_failure_cooldown_minutes)) *
			60,
		Math.max(1, Math.floor(runtimeSettings.model_failure_cooldown_threshold)),
	);
	const callTokenRows = await listCallTokens(c.env.DB, {
		channelIds,
	});
	const callTokenMap = new Map<
		string,
		Array<{
			id: string;
			name: string;
			api_key: string;
		}>
	>();
	for (const row of callTokenRows) {
		const entry = {
			id: row.id,
			name: row.name,
			api_key: row.api_key,
			priority: row.priority ?? 0,
		};
		const list = callTokenMap.get(row.channel_id) ?? [];
		list.push(entry);
		callTokenMap.set(row.channel_id, list);
	}
	const sitesList = channels.map((channel) => {
		const tokens = callTokenMap.get(channel.id) ?? [];
		const callTokens =
			tokens.length > 0
				? tokens
				: channel.api_key
					? [
							{
								id: "",
								name: "主调用令牌",
								api_key: channel.api_key,
								priority: 0,
							},
						]
					: [];
		const coolingModels = (coolingModelMap.get(channel.id) ?? []).map(
			(entry) => ({
				model: entry.model,
				last_err_at: entry.last_err_at,
				last_err_code: entry.last_err_code,
				last_err_count: entry.last_err_count,
				cooldown_count: entry.cooldown_count,
				remaining_seconds: entry.remaining_seconds,
			}),
		);
		return buildSiteRecord(channel, callTokens, coolingModels);
	});
	const taskReports = await listSiteTaskReports(c.env.DB);
	return c.json({ sites: sitesList, task_reports: taskReports });
});

sites.post("/", async (c) => {
	const body = (await c.req.json().catch(() => null)) as SitePayload | null;
	if (!body) {
		return jsonError(c, 400, "missing_body", "missing_body");
	}
	const name = trimValue(body.name);
	if (!name) {
		return jsonError(c, 400, "missing_name", "missing_name");
	}
	const id = generateToken("ch_");
	const now = nowIso();
	const siteType = parseSiteType(body.site_type);
	const baseUrl = resolveBaseUrl(siteType, body.base_url);
	if (!baseUrl) {
		return jsonError(c, 400, "missing_base_url", "missing_base_url");
	}
	const callTokens = normalizeCallTokens(body.call_tokens, body.api_key);
	if (callTokens.length === 0) {
		return jsonError(c, 400, "missing_call_tokens", "missing_call_tokens");
	}
	const systemToken = trimValue(body.system_token ?? body.checkin_token);
	const systemUser = trimValue(body.system_userid ?? body.checkin_userid);
	const checkinUrl =
		body.checkin_url !== undefined && body.checkin_url !== null
			? trimValue(body.checkin_url)
			: "";
	const checkinEnabled = supportsSiteCheckin(siteType)
		? parseBoolean(body.checkin_enabled, body.checkin_status === "active")
		: false;
	if (checkinEnabled && (!systemToken || !systemUser)) {
		return jsonError(
			c,
			400,
			"missing_checkin_credentials",
			"missing_checkin_credentials",
		);
	}
	const metadataJson = buildSiteMetadata(null, {
		site_type: siteType,
		request_entry: {
			path: body.request_entry_path ?? null,
			format: normalizeRequestEntryFormat(body.request_entry_format),
		},
		manual_include_models: body.manual_include_models,
		manual_exclude_models: body.manual_exclude_models,
		probe_concurrency: body.probe_concurrency,
		probe_delay_ms: body.probe_delay_ms,
	});
	await insertChannel(c.env.DB, {
		id,
		name,
		base_url: baseUrl,
		api_key: callTokens[0].api_key,
		weight: Number(body.weight ?? 1),
		status: body.status ?? "active",
		rate_limit: 0,
		models_json: "[]",
		type: 1,
		group_name: null,
		priority: 0,
		metadata_json: metadataJson,
		system_token: systemToken || null,
		system_userid: systemUser || null,
		checkin_enabled: checkinEnabled ? 1 : 0,
		checkin_url: checkinUrl || null,
		last_checkin_date: null,
		last_checkin_status: null,
		last_checkin_message: null,
		last_checkin_at: null,
		created_at: now,
		updated_at: now,
	});
	await replaceCallTokensForChannel(
		c.env.DB,
		id,
		toCallTokenRows(id, callTokens, now),
	);
	await triggerBackupAfterDataChange(c.env.DB);

	await invalidateSelectionHotCache(c.env.KV_HOT);
	return c.json({ id });
});

sites.patch("/:id", async (c) => {
	const body = (await c.req.json().catch(() => null)) as SitePayload | null;
	const id = c.req.param("id");
	if (!body) {
		return jsonError(c, 400, "missing_body", "missing_body");
	}
	const current = await getChannelById(c.env.DB, id);
	if (!current) {
		return jsonError(c, 404, "site_not_found", "site_not_found");
	}
	const currentMetadata = parseSiteMetadata(current.metadata_json);
	const nextSiteType = body.site_type
		? parseSiteType(body.site_type)
		: currentMetadata.site_type;
	const baseUrl =
		body.base_url !== undefined
			? resolveBaseUrl(nextSiteType, body.base_url)
			: normalizeBaseUrl(String(current.base_url));
	if (!baseUrl) {
		return jsonError(c, 400, "missing_base_url", "missing_base_url");
	}
	const shouldUpdateTokens =
		body.call_tokens !== undefined || body.api_key !== undefined;
	const callTokens = shouldUpdateTokens
		? normalizeCallTokens(body.call_tokens, body.api_key ?? current.api_key)
		: [];
	if (shouldUpdateTokens && callTokens.length === 0) {
		return jsonError(c, 400, "missing_call_tokens", "missing_call_tokens");
	}
	const shouldUpdateMetadata =
		body.site_type !== undefined ||
		body.request_entry_path !== undefined ||
		body.request_entry_format !== undefined ||
		body.manual_include_models !== undefined ||
		body.manual_exclude_models !== undefined ||
		body.probe_concurrency !== undefined ||
		body.probe_delay_ms !== undefined;
	const metadataJson = shouldUpdateMetadata
		? buildSiteMetadata(current.metadata_json, {
				site_type:
					body.site_type !== undefined
						? nextSiteType
						: currentMetadata.site_type,
				request_entry:
					body.request_entry_path !== undefined ||
					body.request_entry_format !== undefined
						? {
								path:
									body.request_entry_path !== undefined
										? body.request_entry_path
										: currentMetadata.request_entry.path,
								format:
									body.request_entry_format !== undefined
										? normalizeRequestEntryFormat(body.request_entry_format)
										: currentMetadata.request_entry.format,
							}
						: undefined,
				manual_include_models: body.manual_include_models,
				manual_exclude_models: body.manual_exclude_models,
				probe_concurrency: body.probe_concurrency,
				probe_delay_ms: body.probe_delay_ms,
			})
		: (current.metadata_json ?? null);
	const nextSystemToken =
		body.system_token !== undefined || body.checkin_token !== undefined
			? trimValue(body.system_token ?? body.checkin_token)
			: trimValue(current.system_token ?? "");
	const nextSystemUser =
		body.system_userid !== undefined || body.checkin_userid !== undefined
			? trimValue(body.system_userid ?? body.checkin_userid)
			: trimValue(current.system_userid ?? "");
	const nextCheckinUrl =
		body.checkin_url !== undefined
			? body.checkin_url !== null
				? trimValue(body.checkin_url)
				: ""
			: trimValue(current.checkin_url ?? "");
	const currentCheckinEnabled =
		typeof current.checkin_enabled === "boolean"
			? current.checkin_enabled
			: Number(current.checkin_enabled ?? 0) === 1;
	const nextCheckinEnabled = supportsSiteCheckin(nextSiteType)
		? body.checkin_enabled !== undefined || body.checkin_status !== undefined
			? parseBoolean(body.checkin_enabled, body.checkin_status === "active")
			: currentCheckinEnabled
		: false;
	if (nextCheckinEnabled && (!nextSystemToken || !nextSystemUser)) {
		return jsonError(
			c,
			400,
			"missing_checkin_credentials",
			"missing_checkin_credentials",
		);
	}

	await updateChannel(c.env.DB, id, {
		name: body.name ?? current.name,
		base_url: baseUrl,
		api_key: shouldUpdateTokens ? callTokens[0].api_key : current.api_key,
		weight: Number(body.weight ?? current.weight ?? 1),
		status: body.status ?? current.status,
		rate_limit: current.rate_limit ?? 0,
		models_json: current.models_json ?? "[]",
		type: current.type ?? 1,
		group_name: current.group_name ?? null,
		priority: current.priority ?? 0,
		metadata_json: metadataJson,
		system_token: nextSystemToken || null,
		system_userid: nextSystemUser || null,
		checkin_enabled: nextCheckinEnabled ? 1 : 0,
		checkin_url: nextCheckinUrl || null,
		last_checkin_date: current.last_checkin_date ?? null,
		last_checkin_status: current.last_checkin_status ?? null,
		last_checkin_message: current.last_checkin_message ?? null,
		last_checkin_at: current.last_checkin_at ?? null,
		updated_at: nowIso(),
	});
	if (shouldUpdateTokens) {
		await replaceCallTokensForChannel(
			c.env.DB,
			id,
			toCallTokenRows(id, callTokens, nowIso()),
		);
	}
	await triggerBackupAfterDataChange(c.env.DB);

	await invalidateSelectionHotCache(c.env.KV_HOT);
	return c.json({ ok: true });
});

sites.delete("/:id", async (c) => {
	const id = c.req.param("id");
	await deleteChannel(c.env.DB, id);
	await triggerBackupAfterDataChange(c.env.DB);
	await invalidateSelectionHotCache(c.env.KV_HOT);
	return c.json({ ok: true });
});

sites.post("/checkin-all", async (c) => {
	if (await hasRunningTaskReport(c.env.DB, "checkin")) {
		return jsonError(c, 409, "task_already_running", "task_already_running");
	}
	const startedAt = new Date().toISOString();
	let runningReport = buildRunningCheckinTaskReport(startedAt, 0);
	await saveSiteTaskReport(c.env.DB, runningReport);
	try {
		const progressItems: CheckinTaskItem[] = [];
		const result = await runCheckinAllViaWorker(
			c.env.DB,
			c.env,
			new Date(),
			async ({ item, total }) => {
				progressItems.push(item);
				runningReport = buildRunningCheckinTaskReport(
					startedAt,
					total,
					progressItems,
				);
				runningReport.progress.current_site_id = item.id;
				runningReport.progress.current_site_name = item.name;
				await saveSiteTaskReport(c.env.DB, runningReport);
			},
		);
		const completedReport = buildCompletedCheckinTaskReport(
			startedAt,
			result.runsAt,
			result.results,
		);
		await saveSiteTaskReport(c.env.DB, completedReport);
		return c.json({
			results: result.results,
			summary: result.summary,
			runs_at: result.runsAt,
		});
	} catch (error) {
		const finishedAt = new Date().toISOString();
		await saveSiteTaskReport(
			c.env.DB,
			buildFailedTaskReport(
				runningReport,
				finishedAt,
				error instanceof Error ? error.message : "签到任务执行失败",
			),
		);
		throw error;
	}
});

sites.post("/:id/verify", async (c) => {
	const id = c.req.param("id");
	const result = await verifyChannelById(c.env.DB, id);
	if (!result) {
		return jsonError(c, 404, "site_not_found", "site_not_found");
	}
	await invalidateSelectionHotCache(c.env.KV_HOT);
	return c.json(result);
});

sites.post("/:id/cooling-models/reset", async (c) => {
	const id = c.req.param("id");
	const body = (await c.req.json().catch(() => null)) as {
		model?: string;
	} | null;
	const model = String(body?.model ?? "").trim();
	if (!model) {
		return jsonError(c, 400, "missing_model", "missing_model");
	}
	const current = await getChannelById(c.env.DB, id);
	if (!current) {
		return jsonError(c, 404, "site_not_found", "site_not_found");
	}
	const cleared = await clearChannelModelCooldown(c.env.DB, id, model);
	return c.json({ ok: true, cleared });
});

sites.post("/verify-batch", async (c) => {
	if (await hasRunningTaskReport(c.env.DB, "verify-active")) {
		return jsonError(c, 409, "task_already_running", "task_already_running");
	}
	const body = await c.req.json().catch(() => null);
	const ids = Array.isArray(body?.ids)
		? body.ids
				.map((item: unknown) => String(item ?? "").trim())
				.filter((item: string) => item.length > 0)
		: undefined;
	const startedAt = new Date().toISOString();
	const allChannels = await listChannels(c.env.DB, {
		orderBy: "created_at",
		order: "DESC",
	});
	const total =
		ids && ids.length > 0
			? allChannels.filter((channel) => ids.includes(channel.id)).length
			: allChannels.filter((channel) => channel.status === "active").length;
	let runningReport = buildRunningVerificationTaskReport(
		"verify-active",
		startedAt,
		total,
	);
	await saveSiteTaskReport(c.env.DB, runningReport);
	try {
		const progressItems: SiteVerificationResult[] = [];
		const result = await verifySitesByIds(c.env.DB, ids, async ({ item }) => {
			progressItems.push(item.result);
			runningReport = buildRunningVerificationTaskReport(
				"verify-active",
				startedAt,
				total,
				progressItems,
			);
			runningReport.progress.current_site_id = item.site_id;
			runningReport.progress.current_site_name = item.site_name;
			await saveSiteTaskReport(c.env.DB, runningReport);
		});
		const completedReport = buildCompletedVerificationTaskReport(
			"verify-active",
			startedAt,
			result,
		);
		await saveSiteTaskReport(c.env.DB, completedReport);
		if (result.items.length > 0) {
			await invalidateSelectionHotCache(c.env.KV_HOT);
		}
		return c.json(result);
	} catch (error) {
		const finishedAt = new Date().toISOString();
		await saveSiteTaskReport(
			c.env.DB,
			buildFailedTaskReport(
				runningReport,
				finishedAt,
				error instanceof Error ? error.message : "批量验证执行失败",
			),
		);
		throw error;
	}
});

sites.post("/probe-recovery", async (c) => {
	const runsAt = new Date().toISOString();
	const result = await recoverDisabledChannelsViaWorker(c.env.DB, c.env);
	if (result.recovered > 0) {
		await invalidateSelectionHotCache(c.env.KV_HOT);
	}
	return c.json({
		summary: {
			total: result.total,
			attempted: result.attempted,
			recovered: result.recovered,
			failed: result.failed,
		},
		items: result.items,
		runs_at: runsAt,
	});
});

sites.post("/recovery-evaluate", async (c) => {
	if (await hasRunningTaskReport(c.env.DB, "verify-disabled")) {
		return jsonError(c, 409, "task_already_running", "task_already_running");
	}
	const startedAt = new Date().toISOString();
	const disabledChannels = await listChannels(c.env.DB, {
		filters: { status: "disabled" },
		orderBy: "created_at",
		order: "DESC",
	});
	const total = disabledChannels.filter(
		(channel) => Number(channel.auto_disabled_permanent ?? 0) <= 0,
	).length;
	let runningReport = buildRunningVerificationTaskReport(
		"verify-disabled",
		startedAt,
		total,
	);
	await saveSiteTaskReport(c.env.DB, runningReport);
	try {
		const progressItems: SiteVerificationResult[] = [];
		const result = await recoverDisabledChannelsViaWorker(
			c.env.DB,
			c.env,
			async ({ item }) => {
				if (item.verification) {
					progressItems.push(item.verification);
				}
				runningReport = buildRunningVerificationTaskReport(
					"verify-disabled",
					startedAt,
					total,
					progressItems,
				);
				runningReport.progress.current_site_id = item.site_id;
				runningReport.progress.current_site_name = item.site_name;
				await saveSiteTaskReport(c.env.DB, runningReport);
			},
		);
		if (result.recovered > 0) {
			await invalidateSelectionHotCache(c.env.KV_HOT);
		}
		const verificationItems = result.items
			.map((item) => item.verification)
			.filter(
				(
					item,
				): item is NonNullable<(typeof result.items)[number]["verification"]> =>
					Boolean(item),
			);
		const report = await buildVerificationBatchResult(verificationItems);
		const completedReport = buildCompletedVerificationTaskReport(
			"verify-disabled",
			startedAt,
			report,
		);
		await saveSiteTaskReport(c.env.DB, completedReport);
		return c.json(report);
	} catch (error) {
		const finishedAt = new Date().toISOString();
		await saveSiteTaskReport(
			c.env.DB,
			buildFailedTaskReport(
				runningReport,
				finishedAt,
				error instanceof Error ? error.message : "恢复评估执行失败",
			),
		);
		throw error;
	}
});

sites.post("/refresh-active", async (c) => {
	if (await hasRunningTaskReport(c.env.DB, "refresh-active")) {
		return jsonError(c, 409, "task_already_running", "task_already_running");
	}
	const startedAt = new Date().toISOString();
	const activeChannels = await listChannels(c.env.DB, {
		filters: { status: "active" },
		orderBy: "created_at",
		order: "DESC",
	});
	const total = activeChannels.length;
	let runningReport = buildRunningRefreshTaskReport(startedAt, total);
	await saveSiteTaskReport(c.env.DB, runningReport);
	try {
		const progressItems: SiteChannelRefreshBatchReport["items"] = [];
		const result = await refreshActiveChannelsViaWorker(
			c.env.DB,
			c.env,
			async ({ item }) => {
				progressItems.push(item.item);
				runningReport = buildRunningRefreshTaskReport(
					startedAt,
					total,
					progressItems,
				);
				runningReport.progress.current_site_id = item.site_id;
				runningReport.progress.current_site_name = item.site_name;
				await saveSiteTaskReport(c.env.DB, runningReport);
			},
		);
		const report = {
			summary: result.summary,
			items: result.items,
			runs_at: result.runsAt,
		};
		const completedReport = buildCompletedRefreshTaskReport(startedAt, report);
		await saveSiteTaskReport(c.env.DB, completedReport);
		if (result.items.some((item) => item.models_changed)) {
			await invalidateSelectionHotCache(c.env.KV_HOT);
		}
		return c.json(report);
	} catch (error) {
		const finishedAt = new Date().toISOString();
		await saveSiteTaskReport(
			c.env.DB,
			buildFailedTaskReport(
				runningReport,
				finishedAt,
				error instanceof Error ? error.message : "批量更新执行失败",
			),
		);
		throw error;
	}
});

sites.post("/:id/checkin", async (c) => {
	const id = c.req.param("id");
	const result = await runCheckinSingleViaWorker(
		c.env.DB,
		c.env,
		id,
		new Date(),
	);
	if (!result) {
		return jsonError(c, 404, "site_not_found", "site_not_found");
	}
	return c.json({
		result: result.result,
		runs_at: result.runsAt,
	});
});

sites.post("/:id/refresh-preview", async (c) => {
	const id = c.req.param("id");
	const body = (await c.req.json().catch(() => null)) as SitePayload | null;
	if (!body) {
		return jsonError(c, 400, "missing_body", "missing_body");
	}
	const current = await getChannelById(c.env.DB, id);
	if (!current) {
		return jsonError(c, 404, "site_not_found", "site_not_found");
	}
	const currentMetadata = parseSiteMetadata(current.metadata_json);
	const siteType =
		body.site_type !== undefined
			? parseSiteType(body.site_type)
			: currentMetadata.site_type;
	const baseUrl = resolveBaseUrl(siteType, body.base_url);
	if (!baseUrl) {
		return jsonError(c, 400, "missing_base_url", "missing_base_url");
	}
	const callTokens = normalizeCallTokens(body.call_tokens, body.api_key);
	if (callTokens.length === 0) {
		return jsonError(c, 400, "missing_call_tokens", "missing_call_tokens");
	}
	const result = await previewRefreshChannelById(c.env.DB, c.env, id, {
		name: trimValue(body.name) || current.name,
		base_url: baseUrl,
		siteType,
		tokens: callTokens,
	});
	if (!result) {
		return jsonError(c, 404, "site_not_found", "site_not_found");
	}
	return c.json(result);
});

sites.post("/:id/refresh", async (c) => {
	const id = c.req.param("id");
	const result = await refreshChannelById(c.env.DB, c.env, id);
	if (!result) {
		return jsonError(c, 404, "site_not_found", "site_not_found");
	}
	if (result.models_changed) {
		await invalidateSelectionHotCache(c.env.KV_HOT);
	}
	return c.json(result);
});

export default sites;
