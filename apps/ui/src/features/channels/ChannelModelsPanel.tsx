import {
	Button,
	Card,
	Chip,
	Input,
	Pagination,
	SingleSelect,
} from "../../components/ui";
import { useEffect, useState } from "hono/jsx/dom";
import type {
	ModelChannel,
	ModelItem,
	ModelStatusUpdate,
	Site,
} from "../../core/types";
import { buildPageItems } from "../../core/utils";
import {
	channelModelPageSize,
	modelFilterOptions,
	modelStatusOptions,
} from "./constants";
import {
	getChannelModelRows,
	getPagedChannelModelRows,
	type ChannelModelRow,
	type ChannelModelStatusFilter,
} from "./model-rows";

type ProbeUnavailable = { model: string; status: number; message: string };
type ProbeResultData = {
	probed_at: string;
	provider: string;
	total?: number;
	available: string[];
	unavailable: ProbeUnavailable[];
};

type ChannelModelsPanelProps = {
	models: ModelItem[];
	activeModelSite: Site | null;
	previewModels: string[];
	draftModelName: string;
	draftModelStatus: ModelChannel["status"];
	modelSearch: string;
	modelStatusFilter: ChannelModelStatusFilter;
	modelPage: number;
	isActionPending: (key: string) => boolean;
	onDraftModelNameChange: (next: string) => void;
	onDraftModelStatusChange: (next: ModelChannel["status"]) => void;
	onModelSearchChange: (next: string) => void;
	onModelStatusFilterChange: (next: ChannelModelStatusFilter) => void;
	onModelPageChange: (next: number) => void;
	onRefreshDraftSite: (siteId: string) => void;
	onSetModelStatus: (
		channelId: string,
		model: string,
		status: ModelStatusUpdate,
	) => void;
};

const getModelStatusVariant = (status: ModelChannel["status"]) => {
	if (status === "auto") {
		return "success" as const;
	}
	if (status === "manual") {
		return "warning" as const;
	}
	return "danger" as const;
};

export const ChannelModelsPanel = ({
	models,
	activeModelSite,
	previewModels,
	draftModelName,
	draftModelStatus,
	modelSearch,
	modelStatusFilter,
	modelPage,
	isActionPending,
	onDraftModelNameChange,
	onDraftModelStatusChange,
	onModelSearchChange,
	onModelStatusFilterChange,
	onModelPageChange,
	onRefreshDraftSite,
	onSetModelStatus,
}: ChannelModelsPanelProps) => {
	const [probeState, setProbeState] = useState<
		"idle" | "probing" | "done" | "error"
	>("idle");
	const [probeResult, setProbeResult] = useState<ProbeResultData | null>(null);
	const [onlyAvailable, setOnlyAvailable] = useState(false);
	const [expandedUnavailable, setExpandedUnavailable] = useState(false);
	const siteId = activeModelSite?.id;

	const runProbe = async () => {
		if (!siteId) return;
		setProbeState("probing");
		try {
			const res = await fetch(`/api/probe/${siteId}`, { method: "POST" });
			const data = (await res.json()) as ProbeResultData;
			if (!res.ok) throw new Error("probe_failed");
			setProbeResult(data);
			setProbeState("done");
		} catch {
			setProbeState("error");
		}
	};

	useEffect(() => {
		if (!siteId) return;
		let active = true;
		fetch(`/api/probe/${siteId}`)
			.then((r) => r.json())
			.then((d: any) => {
				if (active && d?.probed_models) setProbeResult(d.probed_models);
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [siteId]);

	if (!activeModelSite) {
		return null;
	}
	const modelRows = getChannelModelRows(
		models,
		activeModelSite.id,
		previewModels,
	);
	const modelRowsByStatus = {
		auto: modelRows.filter((item) => item.status === "auto"),
		manual: modelRows.filter((item) => item.status === "manual"),
		excluded: modelRows.filter((item) => item.status === "excluded"),
	};
	const modelPageResult = getPagedChannelModelRows(modelRows, {
		page: modelPage,
		pageSize: channelModelPageSize,
		search: modelSearch,
		status: modelStatusFilter,
	});
	const modelPageItems = buildPageItems(
		modelPageResult.page,
		modelPageResult.totalPages,
	);
	const hasChannelModelRows = modelRows.length > 0;
	const draftModel = draftModelName.trim();
	const draftActionPending = draftModel
		? isActionPending(`model:${activeModelSite.id}:${draftModel}`)
		: false;
	const refreshPending = isActionPending(`site:refresh:${activeModelSite.id}`);
	const setChannelModelStatus = (model: string, status: ModelStatusUpdate) => {
		onSetModelStatus(activeModelSite.id, model, status);
	};
	const submitDraftModel = () => {
		if (!draftModel) {
			return;
		}
		onSetModelStatus(activeModelSite.id, draftModel, draftModelStatus);
		onDraftModelNameChange("");
		onModelSearchChange("");
		onModelStatusFilterChange(draftModelStatus);
		onModelPageChange(1);
	};
	const renderModelRow = (row: ChannelModelRow) => {
		const { model, status } = row;
		const actionPending = isActionPending(
			`model:${activeModelSite.id}:${model}`,
		);
		return (
			<div
				class="grid grid-cols-[minmax(0,1fr)_88px] gap-2 px-3 py-2 md:grid-cols-[minmax(0,1fr)_88px_minmax(220px,auto)] md:items-center md:gap-3"
				key={`${status}:${model}`}
			>
				<div class="min-w-0">
					<p class="truncate text-xs font-semibold text-[color:var(--app-ink)]">
						{model}
					</p>
					{row.rawIds && row.rawIds.length > 0 && (
						<div class="mt-1 flex flex-wrap gap-1">
							{row.rawIds.map((rawId) => (
								<Chip
									key={`${model}:raw:${rawId}`}
									class="max-w-[220px] truncate text-[10px]"
									title={rawId}
								>
									{rawId}
								</Chip>
							))}
						</div>
					)}
				</div>
				<div>
					<Chip variant={getModelStatusVariant(status)}>
						{status === "auto"
							? "自动"
							: status === "manual"
								? "手动"
								: "已排除"}
					</Chip>
				</div>
				<div class="col-span-2 flex flex-wrap justify-start gap-1.5 md:col-span-1 md:justify-end">
					{status === "excluded" && (
						<Button
							class="h-8 px-2 text-[11px]"
							size="sm"
							variant="primary"
							type="button"
							disabled={actionPending}
							onClick={() => setChannelModelStatus(model, "manual")}
						>
							转手动
						</Button>
					)}
					{status !== "excluded" && (
						<Button
							class="h-8 px-2 text-[11px]"
							size="sm"
							type="button"
							disabled={actionPending}
							onClick={() => setChannelModelStatus(model, "excluded")}
						>
							排除
						</Button>
					)}
					{status === "manual" && (
						<Button
							class="h-8 px-2 text-[11px]"
							size="sm"
							variant="ghost"
							type="button"
							disabled={actionPending}
							onClick={() => setChannelModelStatus(model, "auto")}
						>
							删除
						</Button>
					)}
					{status === "excluded" && (
						<Button
							class="h-8 px-2 text-[11px]"
							size="sm"
							variant="ghost"
							type="button"
							disabled={actionPending}
							onClick={() => setChannelModelStatus(model, "auto")}
						>
							删除
						</Button>
					)}
				</div>
			</div>
		);
	};
	return (
		<Card class="p-4">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div class="min-w-0">
					<p class="text-xs font-semibold uppercase tracking-widest text-[color:var(--app-ink-muted)]">
						模型管理
					</p>
					<p class="mt-1 truncate text-xs text-[color:var(--app-ink-muted)]">
						{activeModelSite.name}
					</p>
				</div>
				<div class="flex flex-wrap items-center gap-1.5">
					<Chip variant="success">自动 {modelRowsByStatus.auto.length}</Chip>
					<Chip variant="warning">手动 {modelRowsByStatus.manual.length}</Chip>
					<Chip variant="danger">排除 {modelRowsByStatus.excluded.length}</Chip>
					<Button
						class="h-8 px-3 text-[11px]"
						size="sm"
						type="button"
						disabled={refreshPending}
						onClick={() => onRefreshDraftSite(activeModelSite.id)}
					>
						{refreshPending ? "拉取中..." : "拉取模型"}
					</Button>
					<Button
						class="h-8 px-3 text-[11px]"
						size="sm"
						type="button"
						disabled={refreshPending || probeState === "probing"}
						onClick={runProbe}
					>
						{probeState === "probing" ? "探测中..." : "探测可用模型"}
					</Button>
				</div>
			</div>
			<div class="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_132px_auto]">
				<Input
					placeholder="模型 ID"
					value={draftModelName}
					onInput={(event) =>
						onDraftModelNameChange(
							(event.currentTarget as HTMLInputElement).value,
						)
					}
					onKeyDown={(event) => {
						if (event.key !== "Enter") {
							return;
						}
						event.preventDefault();
						submitDraftModel();
					}}
				/>
				<SingleSelect
					class="w-full"
					value={draftModelStatus}
					options={modelStatusOptions}
					onChange={(next) =>
						onDraftModelStatusChange(next as ModelChannel["status"])
					}
				/>
				<Button
					class="h-10 px-4 text-xs"
					size="md"
					variant="primary"
					type="button"
					disabled={!draftModel || draftActionPending}
					onClick={submitDraftModel}
				>
					{draftActionPending ? "添加中..." : "添加"}
				</Button>
			</div>
			<div class="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_132px]">
				<Input
					placeholder="搜索当前渠道模型"
					value={modelSearch}
					onInput={(event) => {
						onModelSearchChange(
							(event.currentTarget as HTMLInputElement).value,
						);
						onModelPageChange(1);
					}}
				/>
				<SingleSelect
					class="w-full"
					value={modelStatusFilter}
					options={modelFilterOptions}
					onChange={(next) => {
						onModelStatusFilterChange(next as ChannelModelStatusFilter);
						onModelPageChange(1);
					}}
				/>
			</div>
			{hasChannelModelRows && (
				<div class="mt-2 text-xs text-[color:var(--app-ink-muted)]">
					显示 {modelPageResult.rows.length} / {modelPageResult.total}{" "}
					个匹配模型
				</div>
			)}
			{hasChannelModelRows ? (
				<div class="mt-3 overflow-hidden rounded-lg border border-white/70 bg-white/70">
					<div class="grid grid-cols-[minmax(0,1fr)_88px_minmax(220px,auto)] items-center gap-3 border-b border-white/70 px-3 py-2 text-[11px] font-semibold uppercase tracking-widest text-[color:var(--app-ink-muted)]">
						<div>模型</div>
						<div>状态</div>
						<div class="text-right">操作</div>
					</div>
					{modelPageResult.rows.length === 0 ? (
						<div class="px-3 py-6 text-center text-xs text-[color:var(--app-ink-muted)]">
							暂无匹配模型
						</div>
					) : (
						<div class="divide-y divide-white/70">
							{modelPageResult.rows.map((row) => renderModelRow(row))}
						</div>
					)}
					{modelPageResult.totalPages > 1 && (
						<div class="flex flex-wrap items-center justify-between gap-2 border-t border-white/70 px-3 py-2 text-xs text-[color:var(--app-ink-muted)]">
							<span>
								第 {modelPageResult.page} / {modelPageResult.totalPages} 页
							</span>
							<Pagination
								page={modelPageResult.page}
								totalPages={modelPageResult.totalPages}
								items={modelPageItems}
								onPageChange={onModelPageChange}
							/>
						</div>
					)}
				</div>
			) : (
				<div class="mt-3 rounded-lg border border-dashed border-white/70 bg-white/60 px-3 py-4 text-center text-xs text-[color:var(--app-ink-muted)]">
					暂无模型
				</div>
			)}
			{probeResult && (
				<div class="mt-3 rounded-lg border border-white/70 bg-white/60 p-3">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<p class="text-xs font-semibold uppercase tracking-widest text-[color:var(--app-ink-muted)]">
							模型可用性探测
						</p>
						<label class="flex items-center gap-1.5 text-[11px] text-[color:var(--app-ink-muted)]">
							<input
								type="checkbox"
								checked={onlyAvailable}
								onChange={(e) =>
									setOnlyAvailable(
										(e.currentTarget as HTMLInputElement).checked,
									)
								}
							/>
							仅显示可用
						</label>
					</div>
					<p class="mt-1 text-[11px] text-[color:var(--app-ink-muted)]">
						已探测 {probeResult.total ?? probeResult.available.length + probeResult.unavailable.length} 个模型
						· 可用 <span class="font-semibold text-emerald-600">{probeResult.available.length}</span>
						· 不可用 <span class="font-semibold text-rose-600">{probeResult.unavailable.length}</span>
					</p>
					<div class="mt-2 flex flex-wrap items-center gap-1.5">
						<span class="text-[11px] text-[color:var(--app-ink-muted)]">可用:</span>
						{probeResult.available.length === 0 ? (
							<Chip variant="muted" class="text-[10px]">
								无
							</Chip>
						) : (
							probeResult.available.map((m) => (
								<Chip key={m} variant="success" class="text-[10px]">
									{m}
								</Chip>
							))
						)}
					</div>
					{!onlyAvailable && probeResult.unavailable.length > 0 && (
						<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
							<span class="text-[11px] text-[color:var(--app-ink-muted)]">不可用:</span>
							{probeResult.unavailable
								.slice(0, expandedUnavailable ? undefined : 40)
								.map((u) => (
									<Chip
										key={u.model}
										variant="danger"
										class="text-[10px]"
										title={u.message}
									>
										{u.model}
									</Chip>
								))}
							{!expandedUnavailable && probeResult.unavailable.length > 40 && (
								<button
									type="button"
									class="text-[10px] text-[color:var(--app-primary)] underline"
									onClick={() => setExpandedUnavailable(true)}
								>
									展开剩余 {probeResult.unavailable.length - 40} 个
								</button>
							)}
						</div>
					)}
					<p class="mt-2 text-[10px] text-[color:var(--app-ink-muted)]">
						探测于 {probeResult.probed_at} · provider={probeResult.provider}
						（结果已保存，刷新页面可见）
					</p>
				</div>
			)}
			{probeState === "probing" && (
				<p class="mt-2 text-[11px] text-[color:var(--app-ink-muted)]">
					探测中，请稍候…
				</p>
			)}
			{probeState === "error" && (
				<p class="mt-2 text-[11px] text-[color:var(--app-ink-muted)]">
					探测失败，请重试。
				</p>
			)}
		</Card>
	);
};
