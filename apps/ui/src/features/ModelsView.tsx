import { useMemo, useState } from "hono/jsx/dom";
import {
	Card,
	Chip,
	ColumnPicker,
	MultiSelect,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../components/ui";
import type { ModelItem } from "../core/types";
import { loadColumnPrefs, persistColumnPrefs } from "../core/utils";
import { getModelSquareRows } from "./site-model-display";

type ModelsViewProps = {
	models: ModelItem[];
};

const modelColumns = [
	{ id: "model", label: "模型", locked: true },
	{ id: "channels", label: "渠道" },
];
const modelColumnDefaults = modelColumns.map((column) => column.id);
const normalizeModelColumns = (columns: string[]) => {
	const allowed = new Set(modelColumnDefaults);
	const nextSet = new Set([
		"model",
		...columns.filter((id) => allowed.has(id)),
	]);
	return modelColumnDefaults.filter((id) => nextSet.has(id));
};

export const ModelsView = ({ models }: ModelsViewProps) => {
	const [visibleColumns, setVisibleColumns] = useState(() =>
		normalizeModelColumns(
			loadColumnPrefs("columns:models", modelColumnDefaults),
		),
	);
	const visibleColumnSet = useMemo(
		() => new Set(visibleColumns),
		[visibleColumns],
	);
	const updateColumns = (next: string[]) => {
		const normalized = normalizeModelColumns(next);
		setVisibleColumns(normalized);
		persistColumnPrefs("columns:models", normalized);
	};
	const [modelFilters, setModelFilters] = useState<string[]>([]);
	const [channelFilters, setChannelFilters] = useState<string[]>([]);
	const channelCount = new Set(
		models.flatMap((model) => model.channels.map((channel) => channel.id)),
	).size;
	const modelOptions = useMemo(
		() =>
			models.map((model) => ({
				value: model.id,
				label: model.id,
			})),
		[models],
	);
	const channelOptions = useMemo(() => {
		const map = new Map<string, string>();
		for (const model of models) {
			for (const channel of model.channels) {
				if (!map.has(channel.id)) {
					map.set(channel.id, channel.name || channel.id);
				}
			}
		}
		return Array.from(map.entries())
			.map(([value, label]) => ({ value, label }))
			.sort((a, b) => a.label.localeCompare(b.label));
	}, [models]);
	const filteredModels = useMemo(() => {
		const rows = getModelSquareRows(models, {
			models: modelFilters,
			channels: channelFilters,
		});
		return rows.map((row) => ({
			id: row.model,
			channels: row.channels,
		}));
	}, [channelFilters, modelFilters, models]);

	return (
		<div class="animate-fade-up space-y-4">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h3 class="app-title text-lg">模型广场</h3>
					<p class="app-subtitle">
						查看模型在哪些渠道可见，方便快速确认路由覆盖情况。
					</p>
				</div>
				<div class="flex flex-wrap items-center gap-2 text-xs text-[color:var(--app-ink-muted)]">
					<Chip>{models.length} 个模型</Chip>
					<Chip>{channelCount} 个渠道</Chip>
					<ColumnPicker
						columns={modelColumns}
						value={visibleColumns}
						onChange={updateColumns}
					/>
				</div>
			</div>
			<Card variant="compact" class="app-layer-raised space-y-3 p-4">
				<div class="grid gap-3 lg:grid-cols-2">
					<div>
						<p class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]">
							模型
						</p>
						<MultiSelect
							class="w-full"
							options={modelOptions}
							value={modelFilters}
							placeholder="选择模型"
							searchPlaceholder="搜索模型"
							emptyLabel="暂无匹配模型"
							onChange={setModelFilters}
						/>
					</div>
					<div>
						<p class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]">
							渠道
						</p>
						<MultiSelect
							class="w-full"
							options={channelOptions}
							value={channelFilters}
							placeholder="选择渠道"
							searchPlaceholder="搜索渠道"
							emptyLabel="暂无匹配渠道"
							onChange={setChannelFilters}
						/>
					</div>
				</div>
			</Card>
			{models.length === 0 ? (
				<Card class="text-center text-sm text-[color:var(--app-ink-muted)]">
					暂无模型，请先在渠道管理中拉取或添加模型。
				</Card>
			) : (
				<div class="app-surface overflow-x-auto">
					<Table class="min-w-[640px] w-full text-xs sm:text-sm">
						<TableHeader>
							<TableRow>
								{visibleColumnSet.has("model") && <TableHead>模型</TableHead>}
								{visibleColumnSet.has("channels") && (
									<TableHead>渠道</TableHead>
								)}
							</TableRow>
						</TableHeader>
						<TableBody>
							{filteredModels.length === 0 ? (
								<TableRow>
									<TableCell
										class="px-3 py-6 text-center text-sm text-[color:var(--app-ink-muted)]"
										colSpan={visibleColumns.length}
									>
										暂无匹配模型
									</TableCell>
								</TableRow>
							) : (
								filteredModels.map((model) => (
									<TableRow key={model.id}>
										{visibleColumnSet.has("model") && (
											<TableCell>
												<div class="max-w-[360px] truncate font-semibold text-[color:var(--app-ink)]">
													{model.id}
												</div>
											</TableCell>
										)}
										{visibleColumnSet.has("channels") && (
											<TableCell>
												<div class="flex max-w-[640px] flex-wrap gap-1.5">
													{model.channels.map((channel) => (
														<Chip
															key={`${model.id}:${channel}`}
															class="max-w-[220px] truncate"
															title={channel}
														>
															{channel}
														</Chip>
													))}
												</div>
											</TableCell>
										)}
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
				</div>
			)}
		</div>
	);
};
