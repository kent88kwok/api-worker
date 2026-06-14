import type { D1Database } from "@cloudflare/workers-types";
import type { CheckinResultItem, CheckinSummary } from "./checkin";
import type { SiteVerificationBatchResult } from "./site-verification";
import { nowIso } from "../utils/time";

export type SiteTaskKind =
	| "checkin"
	| "verify-active"
	| "verify-disabled"
	| "refresh-active";

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
	models_changed?: boolean;
	models: string[];
};

export type SiteChannelRefreshBatchReport = {
	summary: {
		total: number;
		success: number;
		warning: number;
		failed: number;
	};
	items: SiteChannelRefreshItem[];
	runs_at: string;
};

export type SiteTaskProgress = {
	total: number;
	completed: number;
	success: number;
	warning: number;
	failed: number;
	skipped: number;
	current_site_id?: string | null;
	current_site_name?: string | null;
	updated_at: string;
};

type SiteTaskReportBase = {
	kind: SiteTaskKind;
	status: "running" | "completed" | "failed";
	runtime_instance_id?: string | null;
	runs_at: string;
	started_at: string;
	finished_at?: string | null;
	progress: SiteTaskProgress;
	error_message?: string | null;
};

export type SiteTaskReportState =
	| (SiteTaskReportBase & {
			kind: "checkin";
			summary: CheckinSummary;
			items: CheckinResultItem[];
	  })
	| (SiteTaskReportBase & {
			kind: "verify-active" | "verify-disabled";
			report: SiteVerificationBatchResult;
	  })
	| (SiteTaskReportBase & {
			kind: "refresh-active";
			report: SiteChannelRefreshBatchReport;
	  });

export type SiteTaskReportMap = Partial<
	Record<SiteTaskKind, SiteTaskReportState>
>;

const SITE_TASK_REPORT_SETTING_KEYS: Record<SiteTaskKind, string> = {
	checkin: "site_task_report_checkin",
	"verify-active": "site_task_report_verify_active",
	"verify-disabled": "site_task_report_verify_disabled",
	"refresh-active": "site_task_report_refresh_active",
};

const SITE_TASK_KINDS = Object.keys(
	SITE_TASK_REPORT_SETTING_KEYS,
) as SiteTaskKind[];

const SITE_TASK_KIND_BY_SETTING_KEY = new Map<string, SiteTaskKind>(
	SITE_TASK_KINDS.map((kind) => [SITE_TASK_REPORT_SETTING_KEYS[kind], kind]),
);

let siteTaskRuntimeInstanceId: string | null = null;

function getSiteTaskRuntimeInstanceId(): string {
	if (!siteTaskRuntimeInstanceId) {
		siteTaskRuntimeInstanceId = crypto.randomUUID();
	}
	return siteTaskRuntimeInstanceId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeLegacyProgress(
	kind: SiteTaskKind,
	parsed: Record<string, unknown>,
	runsAt: string,
): SiteTaskProgress | null {
	if (kind === "checkin") {
		if (!isRecord(parsed.summary) || !Array.isArray(parsed.items)) {
			return null;
		}
		return {
			total: Number(parsed.summary.total ?? parsed.items.length ?? 0),
			completed: Number(parsed.summary.total ?? parsed.items.length ?? 0),
			success: Number(parsed.summary.success ?? 0),
			warning: 0,
			failed: Number(parsed.summary.failed ?? 0),
			skipped: Number(parsed.summary.skipped ?? 0),
			current_site_id: null,
			current_site_name: null,
			updated_at: runsAt,
		};
	}
	if (!isRecord(parsed.report)) {
		return null;
	}
	if (kind === "verify-active" || kind === "verify-disabled") {
		const summary = isRecord(parsed.report.summary)
			? parsed.report.summary
			: {};
		return {
			total: Number(summary.total ?? 0),
			completed: Number(summary.total ?? 0),
			success:
				kind === "verify-active"
					? Number(summary.serving ?? 0)
					: Number(summary.recoverable ?? 0),
			warning: kind === "verify-active" ? Number(summary.degraded ?? 0) : 0,
			failed:
				kind === "verify-active"
					? Number(summary.failed ?? 0)
					: Number(summary.not_recoverable ?? 0) + Number(summary.failed ?? 0),
			skipped: Number(summary.skipped ?? 0),
			current_site_id: null,
			current_site_name: null,
			updated_at: runsAt,
		};
	}
	const summary = isRecord(parsed.report.summary) ? parsed.report.summary : {};
	return {
		total: Number(summary.total ?? 0),
		completed: Number(summary.total ?? 0),
		success: Number(summary.success ?? 0),
		warning: Number(summary.warning ?? 0),
		failed: Number(summary.failed ?? 0),
		skipped: 0,
		current_site_id: null,
		current_site_name: null,
		updated_at: runsAt,
	};
}

function normalizeSiteTaskReportState(
	kind: SiteTaskKind,
	parsed: Record<string, unknown>,
): SiteTaskReportState | null {
	const runsAt = String(parsed.runs_at ?? "").trim();
	if (!runsAt) {
		return null;
	}
	const legacyProgress = normalizeLegacyProgress(kind, parsed, runsAt);
	if (!legacyProgress) {
		return null;
	}
	if (
		parsed.status !== "running" &&
		parsed.status !== "completed" &&
		parsed.status !== "failed"
	) {
		return {
			...(parsed as Omit<
				SiteTaskReportState,
				"status" | "started_at" | "progress"
			>),
			status: "completed",
			started_at: runsAt,
			finished_at: runsAt,
			progress: legacyProgress,
			error_message: null,
		} as SiteTaskReportState;
	}
	if (
		!isRecord(parsed.progress) ||
		typeof parsed.progress.total !== "number" ||
		typeof parsed.progress.completed !== "number" ||
		typeof parsed.progress.success !== "number" ||
		typeof parsed.progress.warning !== "number" ||
		typeof parsed.progress.failed !== "number" ||
		typeof parsed.progress.skipped !== "number" ||
		typeof parsed.progress.updated_at !== "string"
	) {
		return null;
	}
	return {
		...(parsed as SiteTaskReportState),
		runtime_instance_id:
			parsed.runtime_instance_id === undefined ||
			parsed.runtime_instance_id === null
				? null
				: String(parsed.runtime_instance_id),
		started_at: String(parsed.started_at ?? runsAt),
		finished_at:
			parsed.finished_at === undefined || parsed.finished_at === null
				? null
				: String(parsed.finished_at),
		error_message:
			parsed.error_message === undefined || parsed.error_message === null
				? null
				: String(parsed.error_message),
		progress: {
			...legacyProgress,
			...parsed.progress,
		},
	};
}

function parseSiteTaskReport(
	kind: SiteTaskKind,
	value: string,
): SiteTaskReportState | null {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!isRecord(parsed) || parsed.kind !== kind) {
			return null;
		}
		return normalizeSiteTaskReportState(kind, parsed);
	} catch {
		return null;
	}
}

function shouldInvalidateRunningReport(report: SiteTaskReportState): boolean {
	if (report.status !== "running") {
		return false;
	}
	if (report.runtime_instance_id === null) {
		return true;
	}
	return report.runtime_instance_id !== getSiteTaskRuntimeInstanceId();
}

function buildInvalidatedRunningReport(
	report: SiteTaskReportState,
): SiteTaskReportState {
	const finishedAt = nowIso();
	return {
		...report,
		status: "failed",
		finished_at: finishedAt,
		runtime_instance_id: getSiteTaskRuntimeInstanceId(),
		error_message:
			report.error_message?.trim() ||
			"任务所属服务实例已重启，旧的运行中状态已自动结束。",
		progress: {
			...report.progress,
			current_site_id: null,
			current_site_name: null,
			updated_at: finishedAt,
		},
	};
}

async function upsertSetting(
	db: D1Database,
	key: string,
	value: string,
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
		)
		.bind(key, value, nowIso())
		.run();
}

export async function listSiteTaskReports(
	db: D1Database,
): Promise<SiteTaskReportMap> {
	const keys = SITE_TASK_KINDS.map(
		(kind) => SITE_TASK_REPORT_SETTING_KEYS[kind],
	);
	if (keys.length === 0) {
		return {};
	}
	const placeholders = keys.map(() => "?").join(", ");
	const result = await db
		.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
		.bind(...keys)
		.all<{ key: string; value: string }>();
	const reports: SiteTaskReportMap = {};
	for (const row of result.results ?? []) {
		const kind = SITE_TASK_KIND_BY_SETTING_KEY.get(String(row.key));
		if (!kind) {
			continue;
		}
		const parsedReport = parseSiteTaskReport(kind, String(row.value ?? ""));
		const report =
			parsedReport && shouldInvalidateRunningReport(parsedReport)
				? buildInvalidatedRunningReport(parsedReport)
				: parsedReport;
		if (!report) {
			continue;
		}
		reports[kind] = report;
		if (report !== parsedReport) {
			await saveSiteTaskReport(db, report);
		}
	}
	return reports;
}

export async function saveSiteTaskReport(
	db: D1Database,
	report: SiteTaskReportState,
): Promise<void> {
	const normalizedReport =
		report.status === "running"
			? {
					...report,
					runtime_instance_id: getSiteTaskRuntimeInstanceId(),
				}
			: report.runtime_instance_id === undefined
				? report
				: {
						...report,
						runtime_instance_id: report.runtime_instance_id ?? null,
					};
	await upsertSetting(
		db,
		SITE_TASK_REPORT_SETTING_KEYS[normalizedReport.kind],
		JSON.stringify(normalizedReport),
	);
}
