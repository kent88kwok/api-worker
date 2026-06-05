import { useMemo, useState } from "hono/jsx/dom";
import {
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Chip,
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
import {
	resolveAutomaticConflictTarget,
	resolveManualConflictTarget,
} from "../core/canonical-model-conflict-targets";
import type {
	CanonicalModelInput,
	CanonicalModelItem,
	CanonicalModelSyncConflict,
	CanonicalModelSyncResult,
} from "../core/types";
import { formatDateTime } from "../core/utils";

type CanonicalModelsViewProps = {
	items: CanonicalModelItem[];
	isSaving: boolean;
	isSyncing: boolean;
	isCleanupRunning: boolean;
	syncResult: CanonicalModelSyncResult | null;
	onCreate: (payload: CanonicalModelInput) => Promise<void> | void;
	onUpdate: (
		canonicalModel: string,
		payload: CanonicalModelInput,
	) => Promise<void> | void;
	onDelete: (item: CanonicalModelItem) => void;
	onSync: () => Promise<void> | void;
	onCleanupResidualModels: () => Promise<void> | void;
};

type FormState = {
	canonical_model: string;
	import_regex: string;
	aliases: string;
};

type MergeState = {
	alias: string;
	targetCanonicalModel: string;
	targetOptions: MergeTargetOption[];
	recommendedTargetCanonicalModel: string;
};

type ResolvedConflictMerge = {
	alias: string;
	targetCanonicalModel: string;
};

type MergeTargetOption = {
	canonicalModel: string;
	label: string;
	kind: "existing" | "matched";
};

const initialForm: FormState = {
	canonical_model: "",
	import_regex: "",
	aliases: "",
};

const buildForm = (item: CanonicalModelItem): FormState => ({
	canonical_model: item.canonical_model,
	import_regex: item.import_regex ?? "",
	aliases: item.aliases.map((alias) => alias.alias).join("\n"),
});

const formatAliasPreview = (item: CanonicalModelItem) =>
	item.aliases.map((alias) => alias.alias).join(" · ");

const formatSources = (sources: string[]) => sources.join(" / ");

const buildMergeTargetOptions = (
	conflict: CanonicalModelSyncConflict,
): MergeTargetOption[] => {
	const options = new Map<string, MergeTargetOption>();
	for (const canonicalModel of conflict.existing_canonical_models) {
		if (!canonicalModel.trim()) {
			continue;
		}
		options.set(canonicalModel, {
			canonicalModel,
			label: `${canonicalModel}（已有归属）`,
			kind: "existing",
		});
	}
	for (const canonicalModel of conflict.matched_canonical_models) {
		if (!canonicalModel.trim() || options.has(canonicalModel)) {
			continue;
		}
		options.set(canonicalModel, {
			canonicalModel,
			label: `${canonicalModel}（规则命中）`,
			kind: "matched",
		});
	}
	return Array.from(options.values()).sort((left, right) => {
		if (left.kind !== right.kind) {
			return left.kind === "existing" ? -1 : 1;
		}
		return left.canonicalModel.localeCompare(right.canonicalModel);
	});
};

const resolvePreferredMergeTarget = (
	targetOptions: MergeTargetOption[],
): string => targetOptions[0]?.canonicalModel ?? "";

export const CanonicalModelsView = ({
	items,
	isSaving,
	isSyncing,
	isCleanupRunning,
	syncResult,
	onCreate,
	onUpdate,
	onDelete,
	onSync,
	onCleanupResidualModels,
}: CanonicalModelsViewProps) => {
	const [searchText, setSearchText] = useState("");
	const [onlyWithRegex, setOnlyWithRegex] = useState(false);
	const [isCreateOpen, setCreateOpen] = useState(false);
	const [editingItem, setEditingItem] = useState<CanonicalModelItem | null>(
		null,
	);
	const [form, setForm] = useState<FormState>(initialForm);
	const [error, setError] = useState<string | null>(null);
	const [mergeState, setMergeState] = useState<MergeState | null>(null);
	const [syncActionError, setSyncActionError] = useState<string | null>(null);

	const normalizedItems = useMemo(
		() =>
			[...items].sort((left, right) => {
				const leftHasRegex = Boolean(left.import_regex?.trim());
				const rightHasRegex = Boolean(right.import_regex?.trim());
				if (leftHasRegex !== rightHasRegex) {
					return leftHasRegex ? -1 : 1;
				}
				return left.canonical_model.localeCompare(right.canonical_model);
			}),
		[items],
	);
	const filteredItems = useMemo(() => {
		const normalizedSearch = searchText.trim().toLowerCase();
		return normalizedItems.filter((item) => {
			if (onlyWithRegex && !item.import_regex?.trim()) {
				return false;
			}
			if (!normalizedSearch) {
				return true;
			}
			return [
				item.canonical_model,
				item.import_regex ?? "",
				formatAliasPreview(item),
			]
				.join(" ")
				.toLowerCase()
				.includes(normalizedSearch);
		});
	}, [normalizedItems, onlyWithRegex, searchText]);
	const aliasCount = useMemo(
		() => items.reduce((sum, item) => sum + item.aliases.length, 0),
		[items],
	);
	const regexCount = useMemo(
		() => items.filter((item) => item.import_regex?.trim()).length,
		[items],
	);
	const itemLookup = useMemo(
		() => new Map(items.map((item) => [item.canonical_model, item] as const)),
		[items],
	);
	const autoMergeableConflicts = useMemo<ResolvedConflictMerge[]>(
		() =>
			(syncResult?.conflicts ?? [])
				.map((conflict) => {
					const targetCanonicalModel = resolveAutomaticConflictTarget(conflict);
					if (!targetCanonicalModel) {
						return null;
					}
					return {
						alias: conflict.alias,
						targetCanonicalModel,
					};
				})
				.filter((item): item is ResolvedConflictMerge => Boolean(item)),
		[syncResult],
	);
	const autoMergeableConflictCount = autoMergeableConflicts.length;
	const manualConflictCount = Math.max(
		(syncResult?.conflicts.length ?? 0) - autoMergeableConflictCount,
		0,
	);

	const updateForm = (patch: Partial<FormState>) => {
		setForm((prev) => ({ ...prev, ...patch }));
		setError(null);
	};

	const openCreate = () => {
		setEditingItem(null);
		setForm(initialForm);
		setError(null);
		setCreateOpen(true);
	};

	const openEdit = (item: CanonicalModelItem) => {
		setEditingItem(item);
		setForm(buildForm(item));
		setError(null);
		setCreateOpen(false);
	};

	const closeEditor = () => {
		setCreateOpen(false);
		setEditingItem(null);
		setForm(initialForm);
		setError(null);
	};

	const openMerge = (conflict: CanonicalModelSyncConflict) => {
		const targetOptions = buildMergeTargetOptions(conflict);
		const recommendedTarget =
			resolveManualConflictTarget(conflict) ??
			resolvePreferredMergeTarget(targetOptions);
		setError(null);
		setMergeState({
			alias: conflict.alias,
			targetCanonicalModel: recommendedTarget,
			targetOptions,
			recommendedTargetCanonicalModel: recommendedTarget,
		});
	};

	const closeMerge = () => {
		setMergeState(null);
		setError(null);
	};

	const mergeAliasesIntoTarget = async (
		targetCanonicalModel: string,
		aliasesToAppend: Iterable<string>,
	) => {
		const targetItem = itemLookup.get(targetCanonicalModel);
		if (!targetItem) {
			throw new Error(`目标统一名不存在：${targetCanonicalModel}`);
		}
		const aliases = new Set(targetItem.aliases.map((item) => item.alias));
		for (const alias of aliasesToAppend) {
			const normalizedAlias = alias.trim();
			if (normalizedAlias) {
				aliases.add(normalizedAlias);
			}
		}
		await onUpdate(targetItem.canonical_model, {
			canonical_model: targetItem.canonical_model,
			import_regex: targetItem.import_regex,
			aliases: Array.from(aliases).join("\n"),
		});
	};

	const submit = async (event: Event) => {
		event.preventDefault();
		const canonicalModel = form.canonical_model.trim().toLowerCase();
		if (!canonicalModel) {
			setError("请填写统一名");
			return;
		}
		const payload: CanonicalModelInput = {
			canonical_model: canonicalModel,
			import_regex: form.import_regex.trim() || null,
			aliases: form.aliases,
		};
		if (editingItem) {
			await onUpdate(editingItem.canonical_model, payload);
		} else {
			await onCreate(payload);
		}
		closeEditor();
	};

	const submitMerge = async (event: Event) => {
		event.preventDefault();
		if (!mergeState?.alias || !mergeState.targetCanonicalModel) {
			setError("请选择要合并到的统一名");
			return;
		}
		try {
			await mergeAliasesIntoTarget(mergeState.targetCanonicalModel, [
				mergeState.alias,
			]);
			closeMerge();
		} catch (mergeError) {
			setError(
				mergeError instanceof Error
					? mergeError.message
					: "目标统一名不存在，请重新选择",
			);
		}
	};

	const handleMergeAllResolvableConflicts = async () => {
		if (autoMergeableConflicts.length === 0) {
			return;
		}
		setSyncActionError(null);
		const aliasesByCanonicalModel = new Map<string, Set<string>>();
		for (const conflict of autoMergeableConflicts) {
			const aliases =
				aliasesByCanonicalModel.get(conflict.targetCanonicalModel) ?? new Set();
			aliases.add(conflict.alias);
			aliasesByCanonicalModel.set(conflict.targetCanonicalModel, aliases);
		}
		try {
			for (const [canonicalModel, aliases] of aliasesByCanonicalModel) {
				await mergeAliasesIntoTarget(canonicalModel, aliases);
			}
			closeMerge();
		} catch (mergeError) {
			setSyncActionError(
				mergeError instanceof Error
					? mergeError.message
					: "一键合并失败，请刷新后重试",
			);
		}
	};

	return (
		<div class="animate-fade-up space-y-4">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h3 class="app-title text-lg">统一模型</h3>
					<p class="app-subtitle">
						每个统一模型只维护统一名、导入正则和最终生效的精确别名。运行时只认精确别名，正则只用于批量同步。
					</p>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<Chip>{items.length} 个统一模型</Chip>
					<Chip variant="success">{regexCount} 条已配置正则</Chip>
					<Chip variant="accent">{aliasCount} 条精确别名</Chip>
					<Button
						size="sm"
						type="button"
						variant="primary"
						class="h-9 min-w-[112px] justify-center px-4 text-xs"
						disabled={isSyncing}
						onClick={() => void onSync()}
					>
						<span class="inline-flex min-w-[72px] justify-center">
							{isSyncing ? "同步中..." : "一键同步别名"}
						</span>
					</Button>
					<Button
						size="sm"
						type="button"
						variant="ghost"
						class="h-9 min-w-[112px] justify-center px-4 text-xs"
						disabled={isCleanupRunning}
						onClick={() => void onCleanupResidualModels()}
					>
						<span class="inline-flex min-w-[72px] justify-center">
							{isCleanupRunning ? "清理中..." : "清理残留模型"}
						</span>
					</Button>
					<Button
						variant="primary"
						size="sm"
						class="h-9 min-w-[112px] justify-center px-4 text-xs"
						type="button"
						onClick={openCreate}
					>
						<span class="inline-flex min-w-[72px] justify-center">
							新增统一模型
						</span>
					</Button>
				</div>
			</div>

			<Card>
				<CardHeader>
					<div>
						<CardTitle>同步结果</CardTitle>
						<CardDescription>
							一个原始模型名只能自动归属一个统一模型。多规则命中或已归属到其他统一模型时，会进入冲突列表，不会静默覆盖。
						</CardDescription>
					</div>
				</CardHeader>
				<CardContent class="space-y-4">
					<div class="flex flex-wrap gap-2">
						<Chip variant="accent">扫描 {syncResult?.scanned ?? 0} 条</Chip>
						<Chip variant="success">新增 {syncResult?.imported ?? 0} 条</Chip>
						<Chip variant="muted">
							已存在 {syncResult?.already_bound ?? 0} 条
						</Chip>
						<Chip variant="muted">未命中 {syncResult?.unmatched ?? 0} 条</Chip>
						<Chip variant="warning">
							冲突 {syncResult?.conflicts.length ?? 0} 条
						</Chip>
						<Chip variant="warning">
							无效规则 {syncResult?.invalid_rules.length ?? 0} 条
						</Chip>
						<Chip variant="muted">
							最近同步 {formatDateTime(syncResult?.runs_at ?? null)}
						</Chip>
					</div>

					<div class="grid gap-4 xl:grid-cols-2">
						<div class="app-surface flex max-h-96 flex-col overflow-hidden">
							<div class="border-b border-white/60 px-4 py-3">
								<p class="text-sm font-semibold text-[color:var(--app-ink)]">
									本次新增别名
								</p>
							</div>
							<div class="flex-1 overflow-auto">
								<Table class="min-w-[620px] w-full text-xs sm:text-sm">
									<TableHeader>
										<TableRow>
											<TableHead>原始名字</TableHead>
											<TableHead>归属统一名</TableHead>
											<TableHead>来源</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{!syncResult || syncResult.imported_items.length === 0 ? (
											<TableRow>
												<TableCell
													class="px-3 py-8 text-center text-sm text-[color:var(--app-ink-muted)]"
													colSpan={3}
												>
													还没有新增结果。
												</TableCell>
											</TableRow>
										) : (
											syncResult.imported_items.map((item) => (
												<TableRow key={`${item.canonical_model}:${item.alias}`}>
													<TableCell>{item.alias}</TableCell>
													<TableCell>
														<Chip variant="success">
															{item.canonical_model}
														</Chip>
													</TableCell>
													<TableCell>{formatSources(item.sources)}</TableCell>
												</TableRow>
											))
										)}
									</TableBody>
								</Table>
							</div>
						</div>

						<div class="app-surface flex max-h-96 flex-col overflow-hidden">
							<div class="border-b border-white/60 px-4 py-3">
								<div class="flex flex-wrap items-center justify-between gap-3">
									<div>
										<p class="text-sm font-semibold text-[color:var(--app-ink)]">
											规则冲突
										</p>
										<p class="mt-1 text-xs text-[color:var(--app-ink-muted)]">
											可自动合并 {autoMergeableConflictCount} 条，仍需手动处理{" "}
											{manualConflictCount} 条。
										</p>
									</div>
									<Button
										size="sm"
										type="button"
										variant="primary"
										class="h-8 px-3 text-[11px]"
										disabled={
											isSaving || isSyncing || autoMergeableConflictCount === 0
										}
										onClick={() => void handleMergeAllResolvableConflicts()}
									>
										{isSaving ? "合并中..." : "一键合并可判定冲突"}
									</Button>
								</div>
								{syncActionError ? (
									<p class="mt-2 text-xs text-rose-600">{syncActionError}</p>
								) : null}
							</div>
							<div class="flex-1 overflow-auto">
								<Table class="min-w-[920px] w-full text-xs sm:text-sm">
									<TableHeader>
										<TableRow>
											<TableHead>原始名字</TableHead>
											<TableHead>命中统一名</TableHead>
											<TableHead>已有归属</TableHead>
											<TableHead>原因</TableHead>
											<TableHead>操作</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{!syncResult || syncResult.conflicts.length === 0 ? (
											<TableRow>
												<TableCell
													class="px-3 py-8 text-center text-sm text-[color:var(--app-ink-muted)]"
													colSpan={5}
												>
													当前没有冲突。
												</TableCell>
											</TableRow>
										) : (
											syncResult.conflicts.map((item) => (
												<TableRow key={`conflict:${item.alias}`}>
													<TableCell>{item.alias}</TableCell>
													<TableCell>
														<div class="flex max-w-[280px] flex-wrap gap-1.5">
															{item.matched_canonical_models.length > 0 ? (
																item.matched_canonical_models.map(
																	(canonicalModel) => (
																		<Chip
																			key={`${item.alias}:matched:${canonicalModel}`}
																			variant="accent"
																			class="max-w-[240px] truncate text-[10px]"
																			title={canonicalModel}
																		>
																			{canonicalModel}
																		</Chip>
																	),
																)
															) : (
																<span class="text-[11px] text-[color:var(--app-ink-muted)]">
																	-
																</span>
															)}
														</div>
													</TableCell>
													<TableCell>
														<div class="flex max-w-[280px] flex-wrap gap-1.5">
															{item.existing_canonical_models.length > 0 ? (
																item.existing_canonical_models.map(
																	(canonicalModel) => (
																		<Chip
																			key={`${item.alias}:existing:${canonicalModel}`}
																			variant="success"
																			class="max-w-[240px] truncate text-[10px]"
																			title={canonicalModel}
																		>
																			{canonicalModel}
																		</Chip>
																	),
																)
															) : (
																<span class="text-[11px] text-[color:var(--app-ink-muted)]">
																	-
																</span>
															)}
														</div>
													</TableCell>
													<TableCell>
														{item.reason === "multi_match"
															? "多个正则同时命中"
															: "已归属到其他统一名"}
													</TableCell>
													<TableCell>
														<Button
															size="sm"
															type="button"
															variant="primary"
															class="h-8 px-3 text-[11px]"
															disabled={
																item.matched_canonical_models.length === 0 &&
																item.existing_canonical_models.length === 0
															}
															onClick={() => openMerge(item)}
														>
															合并到...
														</Button>
													</TableCell>
												</TableRow>
											))
										)}
									</TableBody>
								</Table>
							</div>
						</div>
					</div>

					{syncResult && syncResult.invalid_rules.length > 0 ? (
						<div class="app-surface flex max-h-72 flex-col overflow-hidden">
							<div class="border-b border-white/60 px-4 py-3">
								<p class="text-sm font-semibold text-[color:var(--app-ink)]">
									无效正则
								</p>
							</div>
							<div class="flex-1 overflow-auto">
								<Table class="min-w-[720px] w-full text-xs sm:text-sm">
									<TableHeader>
										<TableRow>
											<TableHead>统一名</TableHead>
											<TableHead>导入正则</TableHead>
											<TableHead>错误</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{syncResult.invalid_rules.map((item) => (
											<TableRow key={`invalid:${item.canonical_model}`}>
												<TableCell>{item.canonical_model}</TableCell>
												<TableCell>{item.import_regex}</TableCell>
												<TableCell>{item.error}</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						</div>
					) : null}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<div>
						<CardTitle>统一模型主表</CardTitle>
						<CardDescription>
							这里维护统一名、导入正则，以及已经生效的精确别名。
						</CardDescription>
					</div>
				</CardHeader>
				<CardContent class="space-y-4">
					<div class="app-surface p-3">
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]"
							for="canonical-model-search"
						>
							搜索
						</label>
						<Input
							id="canonical-model-search"
							value={searchText}
							placeholder="统一名、导入正则、精确别名"
							onInput={(event) =>
								setSearchText((event.currentTarget as HTMLInputElement).value)
							}
						/>
						<p class="mt-2 text-xs text-[color:var(--app-ink-muted)]">
							当前显示 {filteredItems.length} / {items.length} 条
						</p>
						<div class="mt-3 flex flex-wrap items-center gap-2">
							<Button
								size="sm"
								type="button"
								variant={onlyWithRegex ? "primary" : "ghost"}
								class="h-8 px-3 text-[11px]"
								onClick={() => setOnlyWithRegex((prev) => !prev)}
							>
								{onlyWithRegex ? "显示全部" : "只看有正则"}
							</Button>
							<p class="text-xs text-[color:var(--app-ink-muted)]">
								默认把已配置导入正则的模型排在前面。
							</p>
						</div>
					</div>
					<div class="app-surface overflow-x-auto">
						<Table class="min-w-[1040px] w-full text-xs sm:text-sm">
							<TableHeader>
								<TableRow>
									<TableHead>统一名</TableHead>
									<TableHead>导入正则</TableHead>
									<TableHead>精确别名</TableHead>
									<TableHead>更新时间</TableHead>
									<TableHead>操作</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{filteredItems.length === 0 ? (
									<TableRow>
										<TableCell
											class="px-3 py-8 text-center text-sm text-[color:var(--app-ink-muted)]"
											colSpan={5}
										>
											暂无统一模型，点击新增统一模型开始维护。
										</TableCell>
									</TableRow>
								) : (
									filteredItems.map((item) => (
										<TableRow key={item.canonical_model}>
											<TableCell>
												<div class="font-semibold text-[color:var(--app-ink)]">
													{item.canonical_model}
												</div>
											</TableCell>
											<TableCell>
												<div class="max-w-[260px] break-words text-[11px] text-[color:var(--app-ink-muted)]">
													{item.import_regex || "-"}
												</div>
											</TableCell>
											<TableCell>
												<div class="flex max-w-[420px] flex-wrap gap-1.5">
													{item.aliases.length > 0 ? (
														item.aliases.map((aliasItem) => (
															<Chip
																key={`${item.canonical_model}:${aliasItem.alias}`}
																class="max-w-[220px] truncate text-[10px]"
																title={aliasItem.alias}
															>
																{aliasItem.alias}
															</Chip>
														))
													) : (
														<span class="text-[11px] text-[color:var(--app-ink-muted)]">
															-
														</span>
													)}
												</div>
											</TableCell>
											<TableCell>{formatDateTime(item.updated_at)}</TableCell>
											<TableCell>
												<div class="flex flex-wrap gap-2">
													<Button
														size="sm"
														type="button"
														class="h-8 px-3 text-[11px]"
														onClick={() => openEdit(item)}
													>
														编辑
													</Button>
													<Button
														size="sm"
														type="button"
														variant="ghost"
														class="h-8 px-3 text-[11px]"
														onClick={() => onDelete(item)}
													>
														删除
													</Button>
												</div>
											</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</div>
				</CardContent>
			</Card>

			<Dialog open={isCreateOpen || Boolean(editingItem)} onClose={closeEditor}>
				<DialogContent aria-modal="true" class="max-w-3xl">
					<DialogHeader>
						<div>
							<DialogTitle>
								{editingItem ? "编辑统一模型" : "新增统一模型"}
							</DialogTitle>
							<DialogDescription>
								正则只参与一键同步；真正生效的仍是下面这些精确别名。
							</DialogDescription>
						</div>
						<Button size="sm" type="button" onClick={closeEditor}>
							关闭
						</Button>
					</DialogHeader>
					<form class="mt-4 space-y-4" onSubmit={submit}>
						<div class="space-y-1.5">
							<label
								class="block text-xs font-semibold text-[color:var(--app-ink-muted)]"
								for="canonical-model-id"
							>
								统一名
							</label>
							<Input
								id="canonical-model-id"
								value={form.canonical_model}
								placeholder="例如 x-ai/grok-4.3"
								onInput={(event) =>
									updateForm({
										canonical_model: (event.currentTarget as HTMLInputElement)
											.value,
									})
								}
							/>
						</div>
						<div class="space-y-1.5">
							<label
								class="block text-xs font-semibold text-[color:var(--app-ink-muted)]"
								for="canonical-model-regex"
							>
								导入正则
							</label>
							<Input
								id="canonical-model-regex"
								value={form.import_regex}
								placeholder="例如 ^(?:@hf/google/)?gemma-7b(?:-it)?$"
								onInput={(event) =>
									updateForm({
										import_regex: (event.currentTarget as HTMLInputElement)
											.value,
									})
								}
							/>
						</div>
						<div class="space-y-1.5">
							<label
								class="block text-xs font-semibold text-[color:var(--app-ink-muted)]"
								for="canonical-model-aliases"
							>
								精确别名
							</label>
							<textarea
								id="canonical-model-aliases"
								class="app-input min-h-[140px] w-full resize-y rounded-2xl p-3 text-sm"
								value={form.aliases}
								placeholder="每行一个精确别名"
								onInput={(event) =>
									updateForm({
										aliases: (event.currentTarget as HTMLTextAreaElement).value,
									})
								}
							/>
						</div>
						<DialogFooter class="items-center justify-between">
							{error ? (
								<p class="mr-auto text-xs text-rose-600">{error}</p>
							) : (
								<p class="mr-auto text-xs text-[color:var(--app-ink-muted)]">
									统一名会自动补一条自身精确别名，方便全局匹配。
								</p>
							)}
							<Button size="sm" type="button" onClick={closeEditor}>
								取消
							</Button>
							<Button
								size="sm"
								variant="primary"
								type="submit"
								disabled={isSaving}
							>
								{isSaving ? "保存中..." : "保存"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog open={Boolean(mergeState)} onClose={closeMerge}>
				<DialogContent aria-modal="true" class="max-w-2xl">
					<DialogHeader>
						<div>
							<DialogTitle>合并冲突别名</DialogTitle>
							<DialogDescription>
								把冲突原始名字挂到目标统一模型的精确别名里，保存后会自动重绑。
							</DialogDescription>
						</div>
						<Button size="sm" type="button" onClick={closeMerge}>
							关闭
						</Button>
					</DialogHeader>
					<form class="mt-4 space-y-4" onSubmit={submitMerge}>
						<div class="space-y-1.5">
							<p class="text-xs font-semibold text-[color:var(--app-ink-muted)]">
								冲突原始名字
							</p>
							<p class="rounded-2xl border border-white/60 bg-white/70 px-3 py-2 text-sm text-[color:var(--app-ink)]">
								{mergeState?.alias ?? "-"}
							</p>
						</div>
						<div class="space-y-1.5">
							<p class="block text-xs font-semibold text-[color:var(--app-ink-muted)]">
								合并到统一名
							</p>
							<div id="merge-target-canonical-model">
								<SingleSelect
									value={mergeState?.targetCanonicalModel ?? ""}
									placeholder="请选择合并目标"
									options={
										mergeState?.targetOptions.map((item) => ({
											value: item.canonicalModel,
											label: item.label,
											description:
												item.kind === "existing"
													? "当前这个别名已经挂在这个统一名下"
													: "这是规则匹配出来的候选统一名",
										})) ?? []
									}
									buttonClass="min-h-11 w-full justify-between rounded-2xl border-white/70 bg-white/75 px-3 text-left text-sm shadow-[0_16px_40px_rgba(15,23,42,0.08)]"
									onChange={(next) =>
										setMergeState((prev) =>
											prev
												? {
														...prev,
														targetCanonicalModel: next,
													}
												: prev,
										)
									}
									disabled={(mergeState?.targetOptions.length ?? 0) === 0}
								/>
							</div>
							<div class="space-y-2">
								{mergeState?.recommendedTargetCanonicalModel ? (
									<div class="flex flex-wrap items-center gap-2">
										<span class="text-xs text-[color:var(--app-ink-muted)]">
											推荐目标
										</span>
										<Chip
											variant="success"
											class="max-w-[360px] truncate text-[10px]"
											title={mergeState.recommendedTargetCanonicalModel}
										>
											{mergeState.recommendedTargetCanonicalModel}
										</Chip>
									</div>
								) : null}
								<p class="text-xs text-[color:var(--app-ink-muted)]">
									默认优先选择已有归属；如果还没有已有归属，才会退回规则命中的候选统一名。
								</p>
							</div>
						</div>
						<div class="rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-xs text-amber-700">
							这一步会把当前原始名字追加到目标统一模型的精确别名列表里，适合处理“多规则命中”或“已有归属”这两类冲突。
						</div>
						{error ? <p class="text-xs text-rose-600">{error}</p> : null}
						<DialogFooter>
							<Button size="sm" type="button" onClick={closeMerge}>
								取消
							</Button>
							<Button
								size="sm"
								variant="primary"
								type="submit"
								disabled={isSaving}
							>
								{isSaving ? "合并中..." : "确认合并"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</div>
	);
};
