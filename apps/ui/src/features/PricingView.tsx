import { useMemo, useState } from "hono/jsx/dom";
import {
	Button,
	Chip,
	ColumnPicker,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	SingleSelect,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../components/ui";
import type {
	ModelPrice,
	ModelPriceInput,
	PricingSyncResult,
} from "../core/types";
import {
	formatDateTime,
	loadColumnPrefs,
	persistColumnPrefs,
} from "../core/utils";
import {
	formatCurrencyAmount,
	formatPricingSyncItemLabel,
	getCurrencyDisplayLabel,
	getCurrencySymbol,
	getPricingSyncMessageLabel,
	getPriceSourceLabel,
	getPricingSyncItemTone,
} from "./pricing-display";

type PricingViewProps = {
	prices: ModelPrice[];
	pricingCurrency: string;
	isPricingSyncing: boolean;
	isPricingCurrencySaving: boolean;
	isPricingSaving: boolean;
	isManualPriceCleanupRunning: boolean;
	onPricingSync: () => void;
	onPricingCurrencyChange: (currency: "USD" | "CNY") => Promise<void> | void;
	onPricingCreate: (payload: ModelPriceInput) => Promise<void> | void;
	onPricingUpdate: (
		id: string,
		patch: Partial<ModelPriceInput>,
	) => Promise<void> | void;
	onPricingDelete: (price: ModelPrice) => void;
	onCleanupManualPrices: () => Promise<void> | void;
	lastPricingSyncResult?: PricingSyncResult | null;
};

const priceColumns = [
	{ id: "model", label: "模型", locked: true },
	{ id: "source", label: "来源" },
	{ id: "input", label: "输入" },
	{ id: "cache", label: "缓存" },
	{ id: "output", label: "输出" },
	{ id: "updated", label: "更新时间" },
	{ id: "status", label: "状态" },
	{ id: "actions", label: "操作" },
];

type PriceForm = {
	model_pattern: string;
	input_price_per_1m: string;
	cache_read_price_per_1m: string;
	cache_write_price_per_1m: string;
	output_price_per_1m: string;
};

const initialPriceForm: PriceForm = {
	model_pattern: "",
	input_price_per_1m: "",
	cache_read_price_per_1m: "",
	cache_write_price_per_1m: "",
	output_price_per_1m: "",
};

type PriceEditForm = Pick<
	PriceForm,
	| "input_price_per_1m"
	| "cache_read_price_per_1m"
	| "cache_write_price_per_1m"
	| "output_price_per_1m"
>;

type SourceFilter = "all" | ModelPrice["source"];
type StatusFilter = "all" | "enabled" | "disabled";

const sourceFilterOptions = [
	{
		value: "all",
		label: "全部来源",
		description: "显示手动销售价和同步价格",
	},
	{
		value: "manual",
		label: "手动销售价",
		description: "你在价格中心维护的下游售价",
	},
	{
		value: "official_sync",
		label: "同步价格",
		description: "从上游价格源同步并换算后的价格",
	},
];

const statusFilterOptions = [
	{ value: "all", label: "全部状态", description: "显示启用和停用价格" },
	{ value: "enabled", label: "启用", description: "参与计费匹配" },
	{ value: "disabled", label: "停用", description: "暂不参与计费匹配" },
];

const pricingCurrencyOptions = [
	{
		value: "CNY",
		label: "人民币 (¥)",
		description: "人民币计价，适合直接维护国内销售价",
	},
	{
		value: "USD",
		label: "美元 ($)",
		description: "美元计价，适合直接对照上游官方价格",
	},
];

const getPriceSourceVariant = (
	source: ModelPrice["source"],
	syncStatus?: ModelPrice["sync_status"],
) => {
	if (source === "manual") {
		return "accent" as const;
	}
	if (source === "official_sync") {
		return syncStatus === "exact" ? ("success" as const) : ("warning" as const);
	}
	return "muted" as const;
};

const formatPrice = (value: number, currency: string) => {
	return formatCurrencyAmount(value, currency);
};

const parsePriceValue = (value: string): number | null => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const formatSyncStatusTime = (value: string) => {
	const formatted = formatDateTime(value);
	return formatted === "-" ? "-" : formatted.slice(11, 16) || formatted;
};

const buildEditForm = (price: ModelPrice): PriceEditForm => ({
	input_price_per_1m: String(price.input_price_per_1m),
	cache_read_price_per_1m: String(price.cache_read_price_per_1m),
	cache_write_price_per_1m: String(price.cache_write_price_per_1m),
	output_price_per_1m: String(price.output_price_per_1m),
});

const createPriceFields: Array<{
	key: keyof Pick<
		PriceForm,
		| "input_price_per_1m"
		| "cache_read_price_per_1m"
		| "cache_write_price_per_1m"
		| "output_price_per_1m"
	>;
	id: string;
	label: string;
	placeholder: string;
}> = [
	{
		key: "input_price_per_1m",
		id: "price-input",
		label: "普通输入",
		placeholder: "例如 2.8",
	},
	{
		key: "cache_read_price_per_1m",
		id: "price-cache-read",
		label: "缓存读取",
		placeholder: "留空按 0",
	},
	{
		key: "cache_write_price_per_1m",
		id: "price-cache-write",
		label: "缓存写入",
		placeholder: "留空同普通输入",
	},
	{
		key: "output_price_per_1m",
		id: "price-output",
		label: "输出",
		placeholder: "例如 11.2",
	},
];

export const PricingView = ({
	prices,
	pricingCurrency,
	isPricingSyncing,
	isPricingCurrencySaving,
	isPricingSaving,
	isManualPriceCleanupRunning,
	onPricingSync,
	onPricingCurrencyChange,
	onPricingCreate,
	onPricingUpdate,
	onPricingDelete,
	onCleanupManualPrices,
	lastPricingSyncResult,
}: PricingViewProps) => {
	const pricingCurrencyLabel = getCurrencyDisplayLabel(pricingCurrency);
	const pricingCurrencySymbol = getCurrencySymbol(pricingCurrency);
	const [visibleColumns, setVisibleColumns] = useState(() =>
		loadColumnPrefs(
			"columns:model-prices",
			priceColumns.map((column) => column.id),
		),
	);
	const visibleColumnSet = useMemo(
		() => new Set(visibleColumns),
		[visibleColumns],
	);
	const [priceForm, setPriceForm] = useState<PriceForm>(initialPriceForm);
	const [priceError, setPriceError] = useState<string | null>(null);
	const [isCreateOpen, setCreateOpen] = useState(false);
	const [searchText, setSearchText] = useState("");
	const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
	const [editingPriceId, setEditingPriceId] = useState<string | null>(null);
	const [editForm, setEditForm] = useState<PriceEditForm | null>(null);
	const [editError, setEditError] = useState<string | null>(null);
	const [isSyncReportOpen, setSyncReportOpen] = useState(false);
	const sortedPrices = useMemo(
		() =>
			[...prices].sort((left, right) => {
				const sourceOrder = { manual: 0, official_sync: 1 };
				const sourceDelta =
					sourceOrder[left.source] - sourceOrder[right.source];
				if (sourceDelta !== 0) {
					return sourceDelta;
				}
				return `${left.provider}:${left.model_pattern}`.localeCompare(
					`${right.provider}:${right.model_pattern}`,
				);
			}),
		[prices],
	);
	const priceCounts = useMemo(
		() =>
			prices.reduce(
				(acc, price) => {
					acc.total += 1;
					acc[price.source] += 1;
					return acc;
				},
				{ total: 0, manual: 0, official_sync: 0 },
			),
		[prices],
	);
	const filteredPrices = useMemo(() => {
		const normalizedSearch = searchText.trim().toLowerCase();
		return sortedPrices.filter((price) => {
			if (sourceFilter !== "all" && price.source !== sourceFilter) {
				return false;
			}
			if (statusFilter === "enabled" && !price.enabled) {
				return false;
			}
			if (statusFilter === "disabled" && price.enabled) {
				return false;
			}
			if (!normalizedSearch) {
				return true;
			}
			return [
				price.provider,
				price.model_pattern,
				price.model_name,
				price.currency,
				getPriceSourceLabel(price.source, price.sync_status, price.source_url),
			]
				.join(" ")
				.toLowerCase()
				.includes(normalizedSearch);
		});
	}, [searchText, sortedPrices, sourceFilter, statusFilter]);
	const hasActivePriceFilters =
		searchText.trim().length > 0 ||
		sourceFilter !== "all" ||
		statusFilter !== "all";
	const syncFailedCount =
		lastPricingSyncResult?.items.filter((item) => !item.ok || item.count <= 0)
			.length ?? 0;
	const syncUpdatedCount =
		lastPricingSyncResult?.items.reduce((sum, item) => sum + item.count, 0) ??
		0;
	const syncStatusText = lastPricingSyncResult
		? `${formatSyncStatusTime(lastPricingSyncResult.runs_at)}  ${
				syncFailedCount > 0 ? `失败 ${syncFailedCount}` : "完成"
			}`
		: "暂无";
	const syncStatusClass = lastPricingSyncResult
		? syncFailedCount > 0
			? "border-amber-200 bg-amber-50/90 text-amber-700 transition-colors hover:brightness-[0.98]"
			: "border-slate-200 bg-slate-50/90 text-slate-600 transition-colors hover:brightness-[0.98]"
		: "border-white/60 bg-white/65 text-[color:var(--app-ink-muted)]/80 cursor-default";
	const updateColumns = (next: string[]) => {
		setVisibleColumns(next);
		persistColumnPrefs("columns:model-prices", next);
	};
	const updatePriceForm = (patch: Partial<PriceForm>) => {
		setPriceForm((prev) => ({ ...prev, ...patch }));
		setPriceError(null);
	};
	const updateEditForm = (patch: Partial<PriceEditForm>) => {
		setEditForm((prev) => (prev ? { ...prev, ...patch } : prev));
		setEditError(null);
	};
	const startPriceEdit = (price: ModelPrice) => {
		setEditingPriceId(price.id);
		setEditForm(buildEditForm(price));
		setEditError(null);
	};
	const cancelPriceEdit = () => {
		setEditingPriceId(null);
		setEditForm(null);
		setEditError(null);
	};
	const handlePriceSubmit = async (event: Event) => {
		event.preventDefault();
		const modelPattern = priceForm.model_pattern.trim();
		if (!modelPattern) {
			setPriceError("请填写计费匹配规则，例如 gpt-4.1 或 claude-*");
			return;
		}
		const inputPrice = parsePriceValue(priceForm.input_price_per_1m);
		const cacheReadPrice = parsePriceValue(
			priceForm.cache_read_price_per_1m || "0",
		);
		const cacheWritePrice = parsePriceValue(
			priceForm.cache_write_price_per_1m || priceForm.input_price_per_1m,
		);
		const outputPrice = parsePriceValue(priceForm.output_price_per_1m);
		if (
			inputPrice === null ||
			cacheReadPrice === null ||
			cacheWritePrice === null ||
			outputPrice === null
		) {
			setPriceError("价格需为不小于 0 的数字");
			return;
		}
		await onPricingCreate({
			provider: "manual",
			model_pattern: modelPattern,
			model_name: modelPattern,
			currency: pricingCurrency,
			input_price_per_1m: inputPrice,
			cache_read_price_per_1m: cacheReadPrice,
			cache_write_price_per_1m: cacheWritePrice,
			output_price_per_1m: outputPrice,
			source: "manual",
			enabled: 1,
		});
		setPriceForm((prev) => ({
			...initialPriceForm,
			input_price_per_1m: prev.input_price_per_1m,
			cache_read_price_per_1m: prev.cache_read_price_per_1m,
			cache_write_price_per_1m: prev.cache_write_price_per_1m,
			output_price_per_1m: prev.output_price_per_1m,
		}));
		setCreateOpen(false);
	};
	const handlePriceEditSave = async (price: ModelPrice) => {
		if (!editForm) {
			return;
		}
		const inputPrice = parsePriceValue(editForm.input_price_per_1m);
		const cacheReadPrice = parsePriceValue(editForm.cache_read_price_per_1m);
		const cacheWritePrice = parsePriceValue(editForm.cache_write_price_per_1m);
		const outputPrice = parsePriceValue(editForm.output_price_per_1m);
		if (
			inputPrice === null ||
			cacheReadPrice === null ||
			cacheWritePrice === null ||
			outputPrice === null
		) {
			setEditError("价格需为不小于 0 的数字");
			return;
		}
		await onPricingUpdate(price.id, {
			currency: price.currency || pricingCurrency,
			input_price_per_1m: inputPrice,
			cache_read_price_per_1m: cacheReadPrice,
			cache_write_price_per_1m: cacheWritePrice,
			output_price_per_1m: outputPrice,
			source: "manual",
		});
		cancelPriceEdit();
	};
	const renderPriceEditCell = (
		price: ModelPrice,
		field: keyof PriceEditForm,
		displayValue: number,
		label: string,
		isEditing: boolean,
	) => {
		const inputValue =
			isEditing && editForm ? editForm[field] : String(displayValue);
		return (
			<div class="app-pricing-edit-cell" data-editing={String(isEditing)}>
				<span
					class="app-pricing-edit-cell__display"
					hidden={isEditing}
					aria-hidden={isEditing}
				>
					{formatPrice(displayValue, price.currency)}
				</span>
				<Input
					class="app-pricing-edit-cell__input h-8 text-xs"
					type="number"
					min="0"
					step="0.000001"
					value={inputValue}
					disabled={!isEditing || isPricingSaving}
					hidden={!isEditing}
					aria-label={`${price.model_pattern} ${label}`}
					onInput={(event) =>
						updateEditForm({
							[field]: (event.currentTarget as HTMLInputElement).value,
						})
					}
				/>
			</div>
		);
	};

	return (
		<div class="animate-fade-up space-y-4">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h3 class="app-title text-lg">价格中心</h3>
					<p class="app-subtitle">
						维护每 1M tokens 的下游销售价，手动价优先于同步价，可直接切换 人民币
						¥ / 美元 $。
					</p>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<Chip>{priceCounts.total} 条价格</Chip>
					<Chip variant="accent">{priceCounts.manual} 条手动</Chip>
					<Chip variant="success">{priceCounts.official_sync} 条同步</Chip>
					<div class="min-w-[148px]">
						<SingleSelect
							class="w-full"
							buttonClass="h-9"
							options={pricingCurrencyOptions}
							value={pricingCurrency}
							disabled={isPricingCurrencySaving || isPricingSaving}
							onChange={(next) =>
								onPricingCurrencyChange(next as "USD" | "CNY")
							}
						/>
					</div>
					<ColumnPicker
						columns={priceColumns}
						value={visibleColumns}
						onChange={updateColumns}
					/>
					<Button
						class="h-9 px-4 text-xs"
						size="sm"
						variant="primary"
						type="button"
						onClick={() => setCreateOpen(true)}
					>
						添加价格
					</Button>
					<Button
						class="h-9 px-4 text-xs"
						size="sm"
						variant="ghost"
						type="button"
						disabled={isPricingSyncing}
						onClick={onPricingSync}
					>
						{isPricingSyncing ? "同步中..." : "同步价格"}
					</Button>
					<Button
						class="h-9 min-w-[136px] justify-center px-4 text-xs"
						size="sm"
						variant="ghost"
						type="button"
						disabled={isManualPriceCleanupRunning}
						onClick={onCleanupManualPrices}
						aria-busy={isManualPriceCleanupRunning}
					>
						清理手动价格
					</Button>
					<button
						class={`inline-flex h-9 items-center rounded-full border px-3 text-[11px] leading-none ${syncStatusClass}`}
						type="button"
						disabled={!lastPricingSyncResult}
						onClick={() => setSyncReportOpen(Boolean(lastPricingSyncResult))}
					>
						{syncStatusText}
					</button>
				</div>
			</div>
			<Dialog
				open={isSyncReportOpen && Boolean(lastPricingSyncResult)}
				onClose={() => setSyncReportOpen(false)}
			>
				<DialogContent class="max-w-4xl" aria-modal="true">
					<DialogHeader>
						<div>
							<DialogTitle>最近同步结果</DialogTitle>
							<DialogDescription>
								{lastPricingSyncResult
									? `最后记录 ${formatDateTime(lastPricingSyncResult.runs_at)} · 目标币种 ${getCurrencyDisplayLabel(lastPricingSyncResult.currency)} · 美元/人民币汇率 ${lastPricingSyncResult.usd_cny_rate} · 更新 ${syncUpdatedCount} 条`
									: "暂无同步记录。"}
							</DialogDescription>
						</div>
						<Button
							size="sm"
							type="button"
							onClick={() => setSyncReportOpen(false)}
						>
							关闭
						</Button>
					</DialogHeader>
					<div class="mt-3 max-h-[55vh] space-y-2 overflow-y-auto">
						{lastPricingSyncResult?.items.length ? (
							lastPricingSyncResult.items.map((item) => (
								<div
									class="grid gap-3 rounded-xl border border-white/60 bg-white/80 px-4 py-3 md:grid-cols-[minmax(0,0.75fr)_minmax(0,1.6fr)_auto]"
									key={item.source}
								>
									<div class="min-w-0">
										<p class="truncate text-sm font-semibold text-[color:var(--app-ink)]">
											{item.source}
										</p>
										<p class="text-[11px] text-[color:var(--app-ink-muted)]">
											{item.ok && item.count > 0 ? "成功" : "失败"}
										</p>
									</div>
									<p class="break-words text-xs leading-5 text-[color:var(--app-ink)]">
										{formatPricingSyncItemLabel(item)}
									</p>
									<div class="flex justify-end">
										<Chip variant={getPricingSyncItemTone(item)}>
											{getPricingSyncMessageLabel(item.message)}
										</Chip>
									</div>
								</div>
							))
						) : (
							<p class="text-xs text-[color:var(--app-ink-muted)]">
								暂无同步记录。
							</p>
						)}
					</div>
				</DialogContent>
			</Dialog>
			<Dialog open={isCreateOpen} onClose={() => setCreateOpen(false)}>
				<DialogContent
					aria-labelledby="price-create-title"
					aria-modal="true"
					class="max-w-3xl"
				>
					<DialogHeader>
						<div>
							<DialogTitle id="price-create-title">添加价格</DialogTitle>
							<DialogDescription>
								按当前计价币种保存手动销售价，手动价会优先于同步价格。
							</DialogDescription>
						</div>
						<Button
							size="sm"
							type="button"
							onClick={() => setCreateOpen(false)}
						>
							关闭
						</Button>
					</DialogHeader>
					<form class="mt-4 space-y-4" onSubmit={handlePriceSubmit}>
						<div class="grid items-start gap-4">
							<div class="space-y-1.5">
								<label
									class="block text-xs font-semibold text-[color:var(--app-ink-muted)]"
									for="price-model-pattern"
								>
									计费匹配规则
								</label>
								<Input
									id="price-model-pattern"
									value={priceForm.model_pattern}
									placeholder="例如 gpt-4.1 或 claude-*"
									onInput={(event) =>
										updatePriceForm({
											model_pattern: (event.currentTarget as HTMLInputElement)
												.value,
										})
									}
								/>
								<p class="text-xs text-[color:var(--app-ink-muted)]">
									用于匹配请求模型，支持 * 通配。
								</p>
							</div>
						</div>
						<div class="space-y-2">
							<div class="flex flex-wrap items-center justify-between gap-2">
								<div class="text-xs font-semibold text-[color:var(--app-ink-muted)]">
									价格
								</div>
								<div class="text-xs text-[color:var(--app-ink-muted)]">
									单位：{pricingCurrencySymbol} / 每 1M tokens
								</div>
							</div>
							<div class="grid items-start gap-4 md:grid-cols-2">
								{createPriceFields.map((field) => (
									<div class="space-y-1.5" key={field.key}>
										<label
											class="block text-xs font-semibold text-[color:var(--app-ink-muted)]"
											for={field.id}
										>
											{field.label}
										</label>
										<Input
											id={field.id}
											type="number"
											min="0"
											step="0.000001"
											placeholder={field.placeholder}
											value={priceForm[field.key]}
											onInput={(event) =>
												updatePriceForm({
													[field.key]: (event.currentTarget as HTMLInputElement)
														.value,
												})
											}
										/>
									</div>
								))}
							</div>
						</div>
						<DialogFooter class="items-center justify-between">
							{priceError ? (
								<p class="mr-auto text-xs text-rose-600">{priceError}</p>
							) : (
								<p class="mr-auto text-xs text-[color:var(--app-ink-muted)]">
									当前计价币种：{pricingCurrencyLabel}
								</p>
							)}
							<Button
								size="sm"
								type="button"
								onClick={() => setCreateOpen(false)}
							>
								取消
							</Button>
							<Button
								size="sm"
								variant="primary"
								type="submit"
								disabled={isPricingSaving}
							>
								{isPricingSaving ? "保存中..." : "保存手动价"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			{editError ? <p class="text-xs text-rose-600">{editError}</p> : null}
			<div class="app-surface p-3">
				<div class="grid gap-3 lg:grid-cols-[minmax(240px,1fr)_180px_160px_auto]">
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]"
							for="pricing-search"
						>
							搜索
						</label>
						<Input
							id="pricing-search"
							value={searchText}
							placeholder="模型、显示名、Provider"
							onInput={(event) =>
								setSearchText((event.currentTarget as HTMLInputElement).value)
							}
						/>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]"
							for="pricing-source-filter"
						>
							来源
						</label>
						<div id="pricing-source-filter">
							<SingleSelect
								class="w-full"
								buttonClass="h-10"
								options={sourceFilterOptions}
								value={sourceFilter}
								onChange={(next) => setSourceFilter(next as SourceFilter)}
							/>
						</div>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]"
							for="pricing-status-filter"
						>
							状态
						</label>
						<div id="pricing-status-filter">
							<SingleSelect
								class="w-full"
								buttonClass="h-10"
								options={statusFilterOptions}
								value={statusFilter}
								onChange={(next) => setStatusFilter(next as StatusFilter)}
							/>
						</div>
					</div>
					<div class="flex items-end">
						<Button
							class="h-10 w-full px-4 text-xs"
							size="sm"
							variant="ghost"
							type="button"
							disabled={!hasActivePriceFilters}
							onClick={() => {
								setSearchText("");
								setSourceFilter("all");
								setStatusFilter("all");
							}}
						>
							清空筛选
						</Button>
					</div>
				</div>
				<p class="mt-2 text-xs text-[color:var(--app-ink-muted)]">
					当前显示 {filteredPrices.length} / {priceCounts.total} 条价格
				</p>
			</div>
			<div class="app-surface overflow-x-auto">
				<Table class="min-w-[980px] w-full text-xs sm:text-sm">
					<TableHeader>
						<TableRow>
							{visibleColumnSet.has("model") && <TableHead>模型</TableHead>}
							{visibleColumnSet.has("source") && <TableHead>来源</TableHead>}
							{visibleColumnSet.has("input") && (
								<TableHead>普通输入 / 1M tokens</TableHead>
							)}
							{visibleColumnSet.has("cache") && (
								<TableHead>缓存读/写 / 1M tokens</TableHead>
							)}
							{visibleColumnSet.has("output") && (
								<TableHead>输出 / 1M tokens</TableHead>
							)}
							{visibleColumnSet.has("updated") && (
								<TableHead>更新时间</TableHead>
							)}
							{visibleColumnSet.has("status") && <TableHead>状态</TableHead>}
							{visibleColumnSet.has("actions") && <TableHead>操作</TableHead>}
						</TableRow>
					</TableHeader>
					<TableBody>
						{filteredPrices.length === 0 ? (
							<TableRow>
								<TableCell
									class="px-3 py-8 text-center text-sm text-[color:var(--app-ink-muted)]"
									colSpan={visibleColumns.length}
								>
									{hasActivePriceFilters
										? "没有符合筛选条件的价格。"
										: "暂无价格，点击添加价格或同步价格。"}
								</TableCell>
							</TableRow>
						) : (
							filteredPrices.map((price) => {
								const isEditing =
									editingPriceId === price.id && editForm !== null;
								return (
									<TableRow key={price.id}>
										{visibleColumnSet.has("model") && (
											<TableCell>
												<div class="max-w-[260px]">
													<div class="truncate font-semibold text-[color:var(--app-ink)]">
														{price.model_pattern}
													</div>
													<div class="mt-1 truncate text-[11px] text-[color:var(--app-ink-muted)]">
														{price.provider} · {price.model_name}
													</div>
												</div>
											</TableCell>
										)}
										{visibleColumnSet.has("source") && (
											<TableCell>
												<Chip
													variant={getPriceSourceVariant(
														price.source,
														price.sync_status,
													)}
												>
													{getPriceSourceLabel(
														price.source,
														price.sync_status,
														price.source_url,
													)}
												</Chip>
											</TableCell>
										)}
										{visibleColumnSet.has("input") && (
											<TableCell>
												{renderPriceEditCell(
													price,
													"input_price_per_1m",
													price.input_price_per_1m,
													"普通输入价格",
													isEditing,
												)}
											</TableCell>
										)}
										{visibleColumnSet.has("cache") && (
											<TableCell>
												<div
													class="app-pricing-edit-cell app-pricing-edit-cell--stacked"
													data-editing={String(isEditing)}
												>
													<div class="app-pricing-edit-cell__row">
														<span class="app-pricing-edit-cell__prefix">
															读
														</span>
														<span
															class="app-pricing-edit-cell__display"
															hidden={isEditing}
															aria-hidden={isEditing}
														>
															{formatPrice(
																price.cache_read_price_per_1m,
																price.currency,
															)}
														</span>
														<Input
															class="app-pricing-edit-cell__input h-8 text-xs"
															type="number"
															min="0"
															step="0.000001"
															value={
																isEditing && editForm
																	? editForm.cache_read_price_per_1m
																	: String(price.cache_read_price_per_1m)
															}
															disabled={!isEditing || isPricingSaving}
															hidden={!isEditing}
															aria-label={`${price.model_pattern} 缓存读取价格`}
															onInput={(event) =>
																updateEditForm({
																	cache_read_price_per_1m: (
																		event.currentTarget as HTMLInputElement
																	).value,
																})
															}
														/>
													</div>
													<div class="app-pricing-edit-cell__row">
														<span class="app-pricing-edit-cell__prefix">
															写
														</span>
														<span
															class="app-pricing-edit-cell__display"
															hidden={isEditing}
															aria-hidden={isEditing}
														>
															{formatPrice(
																price.cache_write_price_per_1m,
																price.currency,
															)}
														</span>
														<Input
															class="app-pricing-edit-cell__input h-8 text-xs"
															type="number"
															min="0"
															step="0.000001"
															value={
																isEditing && editForm
																	? editForm.cache_write_price_per_1m
																	: String(price.cache_write_price_per_1m)
															}
															disabled={!isEditing || isPricingSaving}
															hidden={!isEditing}
															aria-label={`${price.model_pattern} 缓存写入价格`}
															onInput={(event) =>
																updateEditForm({
																	cache_write_price_per_1m: (
																		event.currentTarget as HTMLInputElement
																	).value,
																})
															}
														/>
													</div>
												</div>
											</TableCell>
										)}
										{visibleColumnSet.has("output") && (
											<TableCell>
												{renderPriceEditCell(
													price,
													"output_price_per_1m",
													price.output_price_per_1m,
													"输出价格",
													isEditing,
												)}
											</TableCell>
										)}
										{visibleColumnSet.has("updated") && (
											<TableCell>{formatDateTime(price.updated_at)}</TableCell>
										)}
										{visibleColumnSet.has("status") && (
											<TableCell>
												<Chip variant={price.enabled ? "success" : "muted"}>
													{price.enabled ? "启用" : "停用"}
												</Chip>
											</TableCell>
										)}
										{visibleColumnSet.has("actions") && (
											<TableCell>
												<div
													class="app-pricing-actions"
													data-editing={String(isEditing)}
												>
													<span class="app-pricing-action-slot">
														<Button
															class="h-8 w-full px-3 text-[11px]"
															size="sm"
															type="button"
															disabled={isPricingSaving || isEditing}
															hidden={isEditing}
															onClick={() => startPriceEdit(price)}
														>
															编辑
														</Button>
														<Button
															class="h-8 w-full px-3 text-[11px]"
															size="sm"
															variant="primary"
															type="button"
															disabled={isPricingSaving || !isEditing}
															hidden={!isEditing}
															onClick={() => handlePriceEditSave(price)}
														>
															保存
														</Button>
													</span>
													<span class="app-pricing-action-slot">
														<Button
															class="h-8 w-full px-3 text-[11px]"
															size="sm"
															type="button"
															disabled={isPricingSaving || isEditing}
															hidden={isEditing}
															onClick={() =>
																onPricingUpdate(price.id, {
																	enabled: price.enabled ? 0 : 1,
																})
															}
														>
															{price.enabled ? "停用" : "启用"}
														</Button>
														<Button
															class="h-8 w-full px-3 text-[11px]"
															size="sm"
															variant="ghost"
															type="button"
															disabled={isPricingSaving || !isEditing}
															hidden={!isEditing}
															onClick={cancelPriceEdit}
														>
															取消
														</Button>
													</span>
													<span class="app-pricing-action-slot">
														<Button
															class="h-8 w-full px-3 text-[11px]"
															size="sm"
															variant="ghost"
															type="button"
															disabled={isPricingSaving || isEditing}
															hidden={isEditing}
															onClick={() => onPricingDelete(price)}
														>
															删除
														</Button>
													</span>
												</div>
											</TableCell>
										)}
									</TableRow>
								);
							})
						)}
					</TableBody>
				</Table>
			</div>
		</div>
	);
};
