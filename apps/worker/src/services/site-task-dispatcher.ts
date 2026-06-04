import type { D1Database } from "@cloudflare/workers-types";
import type { Bindings } from "../env";
import {
	runCheckin,
	summarizeCheckin,
	type CheckinResultItem,
	type CheckinSummary,
} from "./checkin";
import { beijingDateString, nowIso } from "../utils/time";
import {
	listChannels,
	getChannelById,
	updateChannelCheckinResult,
} from "./channel-repo";
import { getProxyRuntimeSettings } from "./settings";
import {
	listCallTokens,
	updateCallTokenModels,
} from "./channel-call-token-repo";
import { runDisabledChannelRecoveryProbe } from "./channel-recovery-task";
import {
	buildVerificationBatchResult,
	persistSiteVerificationResult,
	verifySiteChannel,
	type SiteVerificationBatchResult,
	type SiteVerificationResult,
} from "./site-verification";
import type {
	SiteTaskCheckinResponse,
	SiteTaskProbeRequest,
	SiteTaskProbeResponse,
	SiteTaskTestRequest,
	SiteTaskTestResponse,
} from "./site-task-contract";
import {
	summarizeChannelTokenFailures,
	testChannelTokens,
	type ChannelTokenTestItem,
} from "./channel-testing";
import { extractModelIds, modelsToJson } from "./channel-models";
import { stageNewlyDiscoveredModels } from "./channel-effective-models";
import { parseChannelMetadata, resolveProvider } from "./channel-metadata";
import { upsertChannelModelCapabilities } from "./channel-model-capabilities";

type SiteTaskRuntime = {
	concurrency: number;
	timeoutMs: number;
	verificationModelLimit: number;
	retrySleepErrorCodes: string[];
	retryReturnErrorCodes: string[];
	channelDisableErrorCodes: string[];
};

type SiteTaskDispatchMode = "main" | "attempt";

type SiteTaskDispatchOptions = {
	mode?: SiteTaskDispatchMode;
};

type InternalWorkerResponse = {
	ok: boolean;
	status: number;
	headers: {
		get(name: string): string | null;
	};
	json(): Promise<unknown>;
	text(): Promise<string>;
};

export type CheckinRunResult = {
	results: CheckinResultItem[];
	summary: CheckinSummary;
	runsAt: string;
};

export type DisabledChannelRecoveryResult = {
	attempted: boolean;
	recovered: boolean;
	reason: string;
	channel_id?: string;
	channel_name?: string;
	model?: string;
	verification?: SiteVerificationResult;
};

export type DisabledChannelRecoveryBatchResult = {
	total: number;
	attempted: number;
	recovered: number;
	failed: number;
	items: DisabledChannelRecoveryResult[];
};

export type SiteChannelRefreshItem = {
	site_id: string;
	site_name: string;
	status: "success" | "warning" | "failed";
	message: string;
	detail_message?: string | null;
	successful_tokens?: string[];
	failed_tokens?: string[];
	failure_groups?: Array<{
		tokens: string[];
		code: string;
		reason: string;
	}>;
	models: string[];
};

export type SiteChannelRefreshBatchResult = {
	summary: {
		total: number;
		success: number;
		warning: number;
		failed: number;
	};
	items: SiteChannelRefreshItem[];
	runsAt: string;
};

type TaskProgressReporter<T> = (payload: {
	item: T;
	index: number;
	total: number;
}) => Promise<void> | void;

type VerificationProgressItem = {
	site_id: string;
	site_name: string;
	verdict: SiteVerificationResult["verdict"];
	result: SiteVerificationResult;
};

type RecoveryProgressItem = {
	site_id: string;
	site_name: string;
	recovered: boolean;
	verification?: SiteVerificationResult;
};

type RefreshProgressItem = {
	site_id: string;
	site_name: string;
	status: SiteChannelRefreshItem["status"];
	item: SiteChannelRefreshItem;
};

type CheckinProgressItem = {
	id: string;
	name: string;
	status: CheckinResultItem["status"];
	message: string;
	checkin_date?: string | null;
};

export async function verifyChannelById(
	db: D1Database,
	channelId: string,
): Promise<SiteVerificationResult | null> {
	const runtimeSettings = await getProxyRuntimeSettings(db);
	const channel = await getChannelById(db, channelId);
	if (!channel) {
		return null;
	}
	const tokenRows = await listCallTokens(db, {
		channelIds: [channelId],
	});
	const tokens =
		tokenRows.length > 0
			? tokenRows.map((row) => ({
					id: row.id,
					name: row.name,
					api_key: row.api_key,
					models_json: row.models_json ?? null,
				}))
			: [
					{
						id: "primary",
						name: "主调用令牌",
						api_key: String(channel.api_key ?? ""),
						models_json: null,
					},
				];
	const result = await verifySiteChannel({
		channel,
		tokens,
		mode: channel.status === "disabled" ? "recovery" : "service",
		runtimeSettings: {
			verification_model_limit: runtimeSettings.verification_model_limit,
			retry_sleep_error_codes: runtimeSettings.retry_sleep_error_codes,
			retry_return_error_codes: runtimeSettings.retry_return_error_codes,
			channel_disable_error_codes: runtimeSettings.channel_disable_error_codes,
		},
	});
	await persistSiteVerificationResult({
		db,
		channel,
		tokens,
		result,
	});
	return result;
}

export async function verifySitesByIds(
	db: D1Database,
	ids?: string[],
	onProgress?: TaskProgressReporter<VerificationProgressItem>,
): Promise<SiteVerificationBatchResult> {
	const runtime = await getSiteTaskRuntime(db);
	const allChannels = await listChannels(db, {
		orderBy: "created_at",
		order: "DESC",
	});
	const channels =
		ids && ids.length > 0
			? allChannels.filter((channel) => ids.includes(channel.id))
			: allChannels.filter((channel) => channel.status === "active");
	const tokenRows = await listCallTokens(db, {
		channelIds: channels.map((channel) => channel.id),
	});
	const tokenMap = new Map<string, typeof tokenRows>();
	for (const row of tokenRows) {
		const list = tokenMap.get(row.channel_id) ?? [];
		list.push(row);
		tokenMap.set(row.channel_id, list);
	}
	const items = await mapWithConcurrency(
		channels,
		runtime.concurrency,
		async (channel) => {
			const channelTokens = tokenMap.get(channel.id) ?? [];
			const tokens =
				channelTokens.length > 0
					? channelTokens.map((row) => ({
							id: row.id,
							name: row.name,
							api_key: row.api_key,
							models_json: row.models_json ?? null,
						}))
					: [
							{
								id: "primary",
								name: "主调用令牌",
								api_key: String(channel.api_key ?? ""),
								models_json: null,
							},
						];
			const result = await verifySiteChannel({
				channel,
				tokens,
				mode: "service",
				runtimeSettings: {
					verification_model_limit: runtime.verificationModelLimit,
					retry_sleep_error_codes: runtime.retrySleepErrorCodes,
					retry_return_error_codes: runtime.retryReturnErrorCodes,
					channel_disable_error_codes: runtime.channelDisableErrorCodes,
				},
			});
			await persistSiteVerificationResult({
				db,
				channel,
				tokens,
				result,
			});
			return {
				site_id: result.site_id,
				site_name: result.site_name,
				verdict: result.verdict,
				result,
			};
		},
		async ({ item, index, total }) => {
			await onProgress?.({
				item: {
					site_id: item.site_id,
					site_name: item.site_name,
					verdict: item.verdict,
					result: item.result,
				},
				index,
				total,
			});
		},
	);
	return buildVerificationBatchResult(items.map((item) => item.result));
}

function createTimeoutSignal(timeoutMs: number) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	return {
		signal: controller.signal,
		clear: () => clearTimeout(timer),
	};
}

function summarizeChannelFailureReasons(
	items: ChannelTokenTestItem[],
): string | null {
	const failedItems = items.filter((item) => !item.ok);
	if (failedItems.length === 0) {
		return null;
	}
	const reasons = new Set<string>();
	for (const item of failedItems) {
		const statusLabel =
			item.httpStatus === null || item.httpStatus === undefined
				? "请求失败"
				: `HTTP ${item.httpStatus}`;
		const detail = normalizeFailureReasonDetail(
			String(item.detail ?? "").trim(),
		);
		reasons.add(detail ? `${statusLabel} | ${detail}` : statusLabel);
	}
	return Array.from(reasons).join("；");
}

function isLikelyHtmlPayload(value: string): boolean {
	return (
		/<!doctype\s+html/i.test(value) ||
		/<html[\s>]/i.test(value) ||
		/<head[\s>]/i.test(value) ||
		/<body[\s>]/i.test(value)
	);
}

function summarizeHtmlFailureDetail(html: string): string {
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
}

function stripReferenceSuffix(value: string): string {
	return value
		.replace(/\s*[;,]?\s*reference\s*=\s*[A-Za-z0-9_-]+/giu, "")
		.replace(/\s*[;,]\s*$/u, "")
		.trim();
}

function normalizeFailureReasonDetail(detail: string): string {
	if (!detail) {
		return "";
	}
	if (isLikelyHtmlPayload(detail)) {
		return summarizeHtmlFailureDetail(detail);
	}
	return stripReferenceSuffix(detail.replace(/\s+/gu, " ").trim());
}

function extractFailureCode(item: ChannelTokenTestItem): string {
	if (item.httpStatus !== null && item.httpStatus !== undefined) {
		return String(item.httpStatus);
	}
	const detail = normalizeFailureReasonDetail(String(item.detail ?? "").trim());
	const match = detail.match(/error code:\s*([A-Za-z0-9_-]+)/iu);
	if (match?.[1]) {
		return match[1];
	}
	return "请求失败";
}

function extractFailureReason(
	item: ChannelTokenTestItem,
	code: string,
): string {
	const detail = normalizeFailureReasonDetail(String(item.detail ?? "").trim());
	if (!detail) {
		return "未找到失败原因";
	}
	const normalized = detail.replace(/\s+/gu, " ").trim();
	if (!normalized) {
		return "未找到失败原因";
	}
	const lower = normalized.toLowerCase();
	const lowerCode = String(code).trim().toLowerCase();
	if (
		lower === `http ${lowerCode}` ||
		lower === `error code: ${lowerCode}` ||
		lower === lowerCode
	) {
		return "未找到失败原因";
	}
	return normalized;
}

function buildChannelFailureGroups(items: ChannelTokenTestItem[]) {
	const groups = new Map<
		string,
		{
			tokens: string[];
			code: string;
			reason: string;
		}
	>();
	for (const item of items) {
		if (item.ok) {
			continue;
		}
		const tokenLabel =
			String(item.tokenName ?? "").trim() ||
			String(item.tokenId ?? "").trim() ||
			"主调用令牌";
		const code = extractFailureCode(item);
		const reason = extractFailureReason(item, code);
		const groupKey = `${code}@@${reason}`;
		const current = groups.get(groupKey);
		if (current) {
			if (!current.tokens.includes(tokenLabel)) {
				current.tokens.push(tokenLabel);
			}
			continue;
		}
		groups.set(groupKey, {
			tokens: [tokenLabel],
			code,
			reason,
		});
	}
	return Array.from(groups.values());
}

async function readInternalError(
	response: InternalWorkerResponse,
): Promise<string> {
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		const payload = await response.json().catch(() => null);
		if (payload && typeof payload === "object") {
			const record = payload as Record<string, unknown>;
			const message = record.error ?? record.message;
			if (typeof message === "string" && message.trim()) {
				return message.trim();
			}
		}
	}
	const text = await response.text().catch(() => "");
	return text.trim() || `HTTP ${response.status}`;
}

async function callAttemptWorker<T>(
	env: Bindings,
	path: string,
	payload: unknown,
	timeoutMs: number,
): Promise<T> {
	const localAttemptWorkerUrl = env.LOCAL_ATTEMPT_WORKER_URL?.trim();
	const binding = env.ATTEMPT_WORKER;
	if (!localAttemptWorkerUrl && !binding) {
		throw new Error("attempt_worker_unavailable");
	}
	const targetUrl = localAttemptWorkerUrl
		? `${localAttemptWorkerUrl.replace(/\/+$/u, "")}${path}`
		: `https://attempt-worker${path}`;
	const requestInit: RequestInit = {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	};
	const executeRequest = async (): Promise<InternalWorkerResponse> => {
		if (localAttemptWorkerUrl) {
			return await fetch(targetUrl, requestInit);
		}
		if (!binding) {
			throw new Error("attempt_worker_unavailable");
		}
		return await binding.fetch(targetUrl, requestInit as never);
	};

	if (timeoutMs > 0) {
		const { signal, clear } = createTimeoutSignal(timeoutMs);
		requestInit.signal = signal;
		try {
			const response = await executeRequest();
			if (!response.ok) {
				throw new Error(await readInternalError(response));
			}
			return (await response.json()) as T;
		} finally {
			clear();
		}
	}
	const response = await executeRequest();
	if (!response.ok) {
		throw new Error(await readInternalError(response));
	}
	return (await response.json()) as T;
}

async function getSiteTaskRuntime(db: D1Database): Promise<SiteTaskRuntime> {
	const runtimeSettings = await getProxyRuntimeSettings(db);
	return {
		concurrency: Math.max(1, runtimeSettings.site_task_concurrency),
		timeoutMs: Math.max(1, runtimeSettings.site_task_timeout_ms),
		verificationModelLimit: Math.max(
			1,
			runtimeSettings.verification_model_limit,
		),
		retrySleepErrorCodes: runtimeSettings.retry_sleep_error_codes,
		retryReturnErrorCodes: runtimeSettings.retry_return_error_codes,
		channelDisableErrorCodes: runtimeSettings.channel_disable_error_codes,
	};
}

async function dispatchWithFallback<T>(
	env: Bindings,
	runtime: SiteTaskRuntime,
	path: string,
	payload: unknown,
	fallback: () => Promise<T>,
): Promise<T> {
	try {
		return await callAttemptWorker<T>(env, path, payload, runtime.timeoutMs);
	} catch {
		return fallback();
	}
}

async function dispatchSiteTask<T>(
	env: Bindings,
	runtime: SiteTaskRuntime,
	path: string,
	payload: unknown,
	runLocally: () => Promise<T>,
	options?: SiteTaskDispatchOptions,
): Promise<T> {
	// Site tasks now run on the main worker by default. If a caller explicitly
	// opts into attempt-worker offload, any offload failure falls back locally.
	if (options?.mode !== "attempt") {
		return runLocally();
	}
	return dispatchWithFallback(env, runtime, path, payload, runLocally);
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
	onItemComplete?: TaskProgressReporter<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const runners = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		async () => {
			while (true) {
				const current = nextIndex;
				nextIndex += 1;
				if (current >= items.length) {
					return;
				}
				results[current] = await worker(items[current], current);
				await onItemComplete?.({
					item: results[current],
					index: current,
					total: items.length,
				});
			}
		},
	);
	await Promise.all(runners);
	return results;
}

export async function executeSiteTestTask(
	db: D1Database,
	env: Bindings,
	payload: SiteTaskTestRequest,
	options?: SiteTaskDispatchOptions,
): Promise<SiteTaskTestResponse> {
	const runtime = await getSiteTaskRuntime(db);
	return dispatchSiteTask(
		env,
		runtime,
		"/internal/site-task/test",
		payload,
		() =>
			testChannelTokens(payload.base_url, payload.tokens, {
				siteType: payload.siteType,
				provider: payload.provider,
			}),
		options,
	);
}

export async function executeSiteCheckinTask(
	db: D1Database,
	env: Bindings,
	payload: {
		site: {
			id: string;
			name: string;
			base_url: string;
			checkin_url?: string | null;
			system_token?: string | null;
			system_userid?: string | null;
		};
	},
	options?: SiteTaskDispatchOptions,
): Promise<SiteTaskCheckinResponse> {
	const runtime = await getSiteTaskRuntime(db);
	return dispatchSiteTask(
		env,
		runtime,
		"/internal/site-task/checkin",
		payload,
		async () => ({
			result: await runCheckin(payload.site),
		}),
		options,
	);
}

export async function executeSiteProbeTask(
	db: D1Database,
	env: Bindings,
	payload: SiteTaskProbeRequest,
	options?: SiteTaskDispatchOptions,
): Promise<SiteTaskProbeResponse> {
	const runtime = await getSiteTaskRuntime(db);
	return dispatchSiteTask(
		env,
		runtime,
		"/internal/site-task/probe",
		payload,
		async () => ({
			result: await runDisabledChannelRecoveryProbe(
				payload.channel,
				payload.tokens,
			),
		}),
		options,
	);
}

export async function runCheckinSingleViaWorker(
	db: D1Database,
	env: Bindings,
	channelId: string,
	now: Date = new Date(),
): Promise<{ result: CheckinResultItem; runsAt: string } | null> {
	const channel = await getChannelById(db, channelId);
	if (!channel) {
		return null;
	}
	const today = beijingDateString(now);
	const alreadyChecked =
		channel.last_checkin_date === today &&
		(channel.last_checkin_status === "success" ||
			channel.last_checkin_status === "skipped");
	if (alreadyChecked) {
		return {
			result: {
				id: channel.id,
				name: channel.name,
				status: "skipped",
				message: channel.last_checkin_message ?? "今日已签到",
				checkin_date: channel.last_checkin_date ?? today,
			},
			runsAt: now.toISOString(),
		};
	}
	const dispatched = await executeSiteCheckinTask(db, env, {
		site: {
			id: channel.id,
			name: channel.name,
			base_url: String(channel.base_url),
			checkin_url: channel.checkin_url ?? null,
			system_token: channel.system_token ?? null,
			system_userid: channel.system_userid ?? null,
		},
	});
	const checkinDate = dispatched.result.checkin_date ?? today;
	await updateChannelCheckinResult(db, channel.id, {
		last_checkin_date: checkinDate,
		last_checkin_status: dispatched.result.status,
		last_checkin_message: dispatched.result.message,
		last_checkin_at: now.toISOString(),
	});
	return {
		result: { ...dispatched.result, checkin_date: checkinDate },
		runsAt: now.toISOString(),
	};
}

export async function runCheckinAllViaWorker(
	db: D1Database,
	env: Bindings,
	now: Date = new Date(),
	onProgress?: TaskProgressReporter<CheckinProgressItem>,
): Promise<CheckinRunResult> {
	const runtime = await getSiteTaskRuntime(db);
	const channels = await listChannels(db, { orderBy: "created_at" });
	const today = beijingDateString(now);
	const resultSlots: Array<CheckinResultItem | null> = [];
	const pending: Array<{
		slotIndex: number;
		channel: (typeof channels)[number];
	}> = [];

	for (const channel of channels) {
		const rawEnabled = channel.checkin_enabled ?? 0;
		const checkinEnabled =
			typeof rawEnabled === "boolean" ? rawEnabled : Number(rawEnabled) === 1;
		if (!checkinEnabled) {
			continue;
		}
		const alreadyChecked =
			channel.last_checkin_date === today &&
			(channel.last_checkin_status === "success" ||
				channel.last_checkin_status === "skipped");
		if (alreadyChecked) {
			resultSlots.push({
				id: channel.id,
				name: channel.name,
				status: "skipped",
				message: channel.last_checkin_message ?? "今日已签到",
				checkin_date: channel.last_checkin_date ?? today,
			});
			continue;
		}
		const slotIndex = resultSlots.length;
		resultSlots.push(null);
		pending.push({ slotIndex, channel });
	}

	await mapWithConcurrency(
		pending,
		runtime.concurrency,
		async ({ slotIndex, channel }) => {
			const dispatched = await executeSiteCheckinTask(db, env, {
				site: {
					id: channel.id,
					name: channel.name,
					base_url: String(channel.base_url),
					checkin_url: channel.checkin_url ?? null,
					system_token: channel.system_token ?? null,
					system_userid: channel.system_userid ?? null,
				},
			});
			const checkinDate = dispatched.result.checkin_date ?? today;
			await updateChannelCheckinResult(db, channel.id, {
				last_checkin_date: checkinDate,
				last_checkin_status: dispatched.result.status,
				last_checkin_message: dispatched.result.message,
				last_checkin_at: now.toISOString(),
			});
			resultSlots[slotIndex] = {
				...dispatched.result,
				checkin_date: checkinDate,
			};
			return null;
		},
		async ({ item: _item, index, total }) => {
			const current = resultSlots[pending[index]?.slotIndex ?? -1];
			if (!current) {
				return;
			}
			await onProgress?.({
				item: {
					id: current.id,
					name: current.name,
					status: current.status,
					message: current.message,
					checkin_date: current.checkin_date ?? null,
				},
				index,
				total,
			});
		},
	);

	const results = resultSlots.filter(
		(item): item is CheckinResultItem => item !== null,
	);
	return {
		results,
		summary: summarizeCheckin(results),
		runsAt: now.toISOString(),
	};
}

async function refreshChannelModels(
	db: D1Database,
	env: Bindings,
	channel: Awaited<ReturnType<typeof getChannelById>>,
): Promise<SiteChannelRefreshItem> {
	if (!channel) {
		return {
			site_id: "",
			site_name: "",
			status: "failed",
			message: "站点不存在",
			detail_message: null,
			successful_tokens: [],
			failed_tokens: [],
			failure_groups: [],
			models: [],
		};
	}
	const tokenRows = await listCallTokens(db, {
		channelIds: [channel.id],
	});
	const tokens =
		tokenRows.length > 0
			? tokenRows.map((row) => ({
					id: row.id,
					name: row.name,
					api_key: row.api_key,
				}))
			: [
					{
						id: "primary",
						name: "主调用令牌",
						api_key: String(channel.api_key ?? ""),
					},
				];
	const metadata = parseChannelMetadata(channel.metadata_json);
	const provider = resolveProvider(metadata.site_type);
	const result = await executeSiteTestTask(db, env, {
		base_url: String(channel.base_url),
		siteType: metadata.site_type,
		provider,
		tokens,
	});
	const successfulTokens = result.items
		.filter((item) => item.ok)
		.map(
			(item) =>
				String(item.tokenName ?? "").trim() ||
				String(item.tokenId ?? "").trim() ||
				"主调用令牌",
		);
	const failedTokens = result.items
		.filter((item) => !item.ok)
		.map(
			(item) =>
				String(item.tokenName ?? "").trim() ||
				String(item.tokenId ?? "").trim() ||
				"主调用令牌",
		);
	if (!result.ok || result.models.length === 0) {
		const failureSummary = summarizeChannelFailureReasons(result.items);
		const failureGroups = buildChannelFailureGroups(result.items);
		return {
			site_id: channel.id,
			site_name: channel.name,
			status: "failed",
			message: result.ok ? "模型接口返回成功，但未发现任何模型" : "更新失败",
			detail_message: failureSummary,
			successful_tokens: successfulTokens,
			failed_tokens: failedTokens,
			failure_groups: failureGroups,
			models: [],
		};
	}
	const updatedAt = nowIso();
	const metadataJson = stageNewlyDiscoveredModels(
		channel.metadata_json,
		extractModelIds(channel),
		result.models,
	);
	await db
		.prepare(
			"UPDATE channels SET models_json = ?, metadata_json = ?, updated_at = ? WHERE id = ?",
		)
		.bind(modelsToJson(result.models), metadataJson, updatedAt, channel.id)
		.run();
	for (const item of result.items) {
		if (!item.tokenId) {
			continue;
		}
		await updateCallTokenModels(db, item.tokenId, item.models, updatedAt);
	}
	await upsertChannelModelCapabilities(db, channel.id, result.models);
	const failureSummary =
		result.failed > 0 ? summarizeChannelTokenFailures(result.items) : null;
	return {
		site_id: channel.id,
		site_name: channel.name,
		status: failureSummary ? "warning" : "success",
		message: failureSummary
			? `已更新 ${result.models.length} 个模型，但部分令牌失败`
			: `已更新 ${result.models.length} 个模型`,
		detail_message: failureSummary,
		successful_tokens: successfulTokens,
		failed_tokens: failedTokens,
		failure_groups: [],
		models: result.models,
	};
}

async function markDisabledChannelRecovered(
	db: D1Database,
	channelId: string,
): Promise<boolean> {
	const updatedAt = nowIso();
	const updateResult = await db
		.prepare(
			"UPDATE channels SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
		)
		.bind("active", updatedAt, channelId, "disabled")
		.run();
	return Number(updateResult.meta?.changes ?? 0) > 0;
}

export async function refreshChannelById(
	db: D1Database,
	env: Bindings,
	channelId: string,
): Promise<SiteChannelRefreshItem | null> {
	const channel = await getChannelById(db, channelId);
	if (!channel) {
		return null;
	}
	if (channel.status !== "active") {
		return {
			site_id: channel.id,
			site_name: channel.name,
			status: "failed",
			message: "仅启用渠道可更新",
			detail_message: null,
			failure_groups: [],
			models: [],
		};
	}
	return refreshChannelModels(db, env, channel);
}

export async function refreshActiveChannelsViaWorker(
	db: D1Database,
	env: Bindings,
	onProgress?: TaskProgressReporter<RefreshProgressItem>,
): Promise<SiteChannelRefreshBatchResult> {
	const runtime = await getSiteTaskRuntime(db);
	const channels = await listChannels(db, {
		filters: { status: "active" },
		orderBy: "created_at",
		order: "DESC",
	});
	if (channels.length === 0) {
		return {
			summary: {
				total: 0,
				success: 0,
				warning: 0,
				failed: 0,
			},
			items: [],
			runsAt: new Date().toISOString(),
		};
	}
	const items = await mapWithConcurrency(
		channels,
		runtime.concurrency,
		async (channel) => {
			try {
				return await refreshChannelModels(db, env, channel);
			} catch (err: unknown) {
				return {
					site_id: channel.id,
					site_name: channel.name,
					status: "failed" as const,
					message: err instanceof Error ? err.message : "未知的执行异常",
					detail_message: null,
					failure_groups: [],
					models: [],
				};
			}
		},
		async ({ item, index, total }) => {
			await onProgress?.({
				item: {
					site_id: item.site_id,
					site_name: item.site_name,
					status: item.status,
					item,
				},
				index,
				total,
			});
		},
	);
	const success = items.filter((item) => item.status === "success").length;
	const warning = items.filter((item) => item.status === "warning").length;
	return {
		summary: {
			total: items.length,
			success,
			warning,
			failed: items.length - success - warning,
		},
		items,
		runsAt: new Date().toISOString(),
	};
}

export async function recoverDisabledChannelsViaWorker(
	db: D1Database,
	_env: Bindings,
	onProgress?: TaskProgressReporter<RecoveryProgressItem>,
): Promise<DisabledChannelRecoveryBatchResult> {
	const runtime = await getSiteTaskRuntime(db);
	const disabledChannels = await listChannels(db, {
		filters: { status: "disabled" },
		orderBy: "created_at",
		order: "DESC",
	});
	const probeTargets = disabledChannels.filter(
		(channel) => Number(channel.auto_disabled_permanent ?? 0) <= 0,
	);
	if (probeTargets.length === 0) {
		return {
			total: 0,
			attempted: 0,
			recovered: 0,
			failed: 0,
			items: [],
		};
	}

	const callTokenRows = await listCallTokens(db, {
		channelIds: probeTargets.map((channel) => channel.id),
	});
	const callTokenMap = new Map<string, typeof callTokenRows>();
	for (const row of callTokenRows) {
		const list = callTokenMap.get(row.channel_id) ?? [];
		list.push(row);
		callTokenMap.set(row.channel_id, list);
	}

	const taskResults = await mapWithConcurrency(
		probeTargets,
		runtime.concurrency,
		async (channel) => {
			try {
				const tokenRows = callTokenMap.get(channel.id) ?? [];
				const tokens =
					tokenRows.length > 0
						? tokenRows.map((row) => ({
								id: row.id,
								name: row.name,
								api_key: row.api_key,
								models_json: row.models_json ?? null,
							}))
						: [
								{
									id: "primary",
									name: "主调用令牌",
									api_key: String(channel.api_key ?? ""),
									models_json: null,
								},
							];
				const verification = await verifySiteChannel({
					channel,
					tokens,
					mode: "recovery",
					runtimeSettings: {
						verification_model_limit: runtime.verificationModelLimit,
						retry_sleep_error_codes: runtime.retrySleepErrorCodes,
						retry_return_error_codes: runtime.retryReturnErrorCodes,
						channel_disable_error_codes: runtime.channelDisableErrorCodes,
					},
				});
				await persistSiteVerificationResult({
					db,
					channel,
					tokens,
					result: verification,
				});

				const recovered =
					verification.verdict === "recoverable"
						? await markDisabledChannelRecovered(db, channel.id)
						: false;
				return {
					attempted: true,
					recovered,
					reason: recovered
						? "eligible_for_recovery"
						: verification.stages.recovery.code,
					channel_id: channel.id,
					channel_name: channel.name,
					model: verification.selected_model ?? undefined,
					verification,
				} satisfies DisabledChannelRecoveryResult;
			} catch (err: unknown) {
				return {
					attempted: true,
					recovered: false,
					reason: "probe_exception",
					channel_id: channel.id,
					channel_name: channel.name,
					verification: {
						site_id: channel.id,
						site_name: channel.name,
						mode: "recovery",
						verdict: "not_recoverable",
						message: err instanceof Error ? err.message : "恢复检测时发生异常",
						suggested_action: "manual_review",
						stages: {
							connectivity: { status: "skip", code: "", message: "" },
							capability: { status: "skip", code: "", message: "" },
							service: { status: "skip", code: "", message: "" },
							recovery: {
								status: "fail",
								code: "probe_exception",
								message:
									err instanceof Error ? err.message : "恢复检测时发生异常",
							},
						},
						selected_model: null,
						selected_token: null,
						discovered_models: [],
						token_results: [],
						token_summary: {
							total: 0,
							success: 0,
							failed: 0,
						},
						trace: {},
						checked_at: new Date().toISOString(),
					},
				} satisfies DisabledChannelRecoveryResult;
			}
		},
		async ({ item, index, total }) => {
			await onProgress?.({
				item: {
					site_id: item.channel_id ?? "",
					site_name: item.channel_name ?? "",
					recovered: item.recovered,
					verification: item.verification,
				},
				index,
				total,
			});
		},
	);

	const attempted = taskResults.filter((item) => item.attempted).length;
	const recovered = taskResults.filter((item) => item.recovered).length;
	return {
		total: taskResults.length,
		attempted,
		recovered,
		failed: attempted - recovered,
		items: taskResults,
	};
}
