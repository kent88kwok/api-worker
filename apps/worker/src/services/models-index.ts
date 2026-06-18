import type { Bindings } from "../env";
import {
	parseManualModelConfig,
	resolveChannelModelStatus,
	type ManualModelStatus,
} from "../domains/channel/effective-models";
import { listVerifiedModelsByChannel } from "../domains/channel/model-capabilities";
import { extractModels, extractModelIds } from "../domains/channel/models";
import { listChannels } from "../domains/channel/repo";
import { deriveCanonicalModel } from "./model-normalization";

export type ModelChannelStatus = "auto" | "manual" | "excluded";

export type ModelsPayload = {
	models: Array<{
		id: string;
		raw_ids?: string[];
		counts: {
			auto: number;
			manual: number;
			excluded: number;
		};
		channels: Array<{
			id: string;
			name: string;
			raw_ids?: string[];
			status: ModelChannelStatus;
		}>;
	}>;
};

function normalizeManagedStatus(
	status: ManualModelStatus,
	isAutomatic: boolean,
): ModelChannelStatus | null {
	if (status === "excluded") {
		return "excluded";
	}
	if (isAutomatic) {
		return "auto";
	}
	if (status === "manual") {
		return "manual";
	}
	return null;
}

function addModelChannel(
	map: Map<string, ModelsPayload["models"][number]>,
	model: string,
	rawIds: string[] | undefined,
	channel: { id: string; name: string },
	status: ModelChannelStatus,
): void {
	const existing = map.get(model) ?? {
		id: model,
		raw_ids: [],
		counts: {
			auto: 0,
			manual: 0,
			excluded: 0,
		},
		channels: [],
	};
	const normalizedRawIds = Array.from(
		new Set(
			(rawIds ?? [])
				.map((rawId) => String(rawId ?? "").trim())
				.filter((rawId) => rawId.length > 0 && rawId !== model),
		),
	);
	for (const rawId of normalizedRawIds) {
		if (!existing.raw_ids?.includes(rawId)) {
			existing.raw_ids?.push(rawId);
		}
	}
	const existingChannel = existing.channels.find(
		(item) => item.id === channel.id && item.status === status,
	);
	if (existingChannel) {
		for (const rawId of normalizedRawIds) {
			const channelRawIds = existingChannel.raw_ids ?? [];
			if (!channelRawIds.includes(rawId)) {
				channelRawIds.push(rawId);
				existingChannel.raw_ids = channelRawIds;
			}
		}
		map.set(model, existing);
		return;
	}
	existing.channels.push({
		id: channel.id,
		name: channel.name,
		raw_ids: normalizedRawIds.length > 0 ? normalizedRawIds : undefined,
		status,
	});
	existing.counts[status] += 1;
	map.set(model, existing);
}

export async function buildModelsPayload(
	db: Bindings["DB"],
): Promise<ModelsPayload> {
	const channels = await listChannels(db, {
		orderBy: "created_at",
		order: "DESC",
	});
	const activeChannelIds = channels
		.filter((channel) => channel.status === "active")
		.map((channel) => channel.id);
	const verified = await listVerifiedModelsByChannel(db, activeChannelIds);
	const map = new Map<string, ModelsPayload["models"][number]>();

	for (const channel of channels) {
		const manual = parseManualModelConfig(channel.metadata_json);
		const candidates = new Set<string>([
			...extractModelIds(channel),
			...(verified.get(channel.id) ?? new Set<string>()),
			...manual.include,
			...manual.exclude,
		]);
		const rawIdsByCanonical = new Map<string, string[]>();
		for (const entry of extractModels(channel)) {
			rawIdsByCanonical.set(entry.id, entry.rawIds ?? [entry.id]);
		}
		for (const model of candidates) {
			const canonicalModel = deriveCanonicalModel(model) ?? model;
			const isAutomatic =
				rawIdsByCanonical.has(canonicalModel) ||
				(verified.get(channel.id)?.has(canonicalModel) ?? false);
			const status = normalizeManagedStatus(
				resolveChannelModelStatus(channel.metadata_json, canonicalModel),
				isAutomatic,
			);
			if (!status) {
				continue;
			}
			addModelChannel(
				map,
				canonicalModel,
				rawIdsByCanonical.get(canonicalModel),
				channel,
				status,
			);
		}
	}

	const payload = {
		models: Array.from(map.values()).sort((left, right) =>
			left.id.localeCompare(right.id),
		),
	};
	for (const model of payload.models) {
		model.raw_ids?.sort((left, right) => left.localeCompare(right));
		model.channels.sort((left, right) => {
			const statusOrder = { auto: 0, manual: 1, excluded: 2 };
			const statusDelta = statusOrder[left.status] - statusOrder[right.status];
			if (statusDelta !== 0) {
				return statusDelta;
			}
			return left.name.localeCompare(right.name);
		});
		for (const channel of model.channels) {
			channel.raw_ids?.sort((left, right) => left.localeCompare(right));
		}
	}
	return payload;
}
