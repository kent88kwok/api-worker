import {
	type ChannelMetadata,
	parseChannelMetadata,
	resolveMappedModel,
} from "./channel-metadata";
import { extractModelIds } from "./channel-models";
import { deriveCanonicalModel } from "./model-normalization";
import {
	buildRequestEntryFormatAttemptOrder,
	resolveEndpointTypeForRequestEntryFormat,
} from "./request-entry-attempts";
import type { EndpointType, ProviderType } from "./provider-transform";
import type { RequestEntryFormat } from "./site-metadata";
import {
	parseManualModelConfig,
	resolveEffectiveModelIds,
} from "./channel-effective-models";
import type { ChannelRecord } from "./channel-types";

export type ChannelAttemptPlanItem = {
	channel: ChannelRecord;
	model: string | null;
	requestEntryFormat?: RequestEntryFormat | null;
	requestEndpointType?: EndpointType | null;
};

function normalizeAttemptModel(
	value: string | null | undefined,
): string | null {
	const normalized = String(value ?? "").trim();
	return normalized || null;
}

function normalizeKnownModel(value: string | null | undefined): string | null {
	return deriveCanonicalModel(value);
}

function hasExplicitModelMapping(
	metadata: ChannelMetadata,
	downstreamModel: string | null,
): boolean {
	if (downstreamModel) {
		const canonicalModel =
			deriveCanonicalModel(downstreamModel) ?? downstreamModel;
		return (
			metadata.model_mapping[canonicalModel] !== undefined ||
			metadata.model_mapping["*"] !== undefined
		);
	}
	return metadata.model_mapping["*"] !== undefined;
}

function collectKnownChannelModels(
	channel: ChannelRecord,
	verifiedModelsByChannel: Map<string, Set<string>>,
): string[] {
	return resolveEffectiveModelIds({
		channel,
		verifiedModels:
			verifiedModelsByChannel.get(channel.id) ?? new Set<string>(),
	})
		.map((model) => normalizeKnownModel(model))
		.filter((model): model is string => Boolean(model));
}

export function resolveUpstreamModelForChannel(
	channel: ChannelRecord,
	metadata: ChannelMetadata,
	downstreamModel: string | null,
	verifiedModelsByChannel: Map<string, Set<string>> = new Map(),
): { model: string | null; autoMapped: boolean } {
	const mapped = resolveMappedModel(metadata.model_mapping, downstreamModel);
	if (!downstreamModel || hasExplicitModelMapping(metadata, downstreamModel)) {
		return { model: mapped, autoMapped: false };
	}

	const knownModels = collectKnownChannelModels(
		channel,
		verifiedModelsByChannel,
	);
	if (knownModels.length === 0) {
		return { model: null, autoMapped: false };
	}
	const canonicalModel =
		deriveCanonicalModel(downstreamModel) ?? downstreamModel;
	if (knownModels.includes(canonicalModel)) {
		return { model: mapped ?? downstreamModel, autoMapped: false };
	}
	return { model: null, autoMapped: false };
}

function channelSupportsModel(
	channel: ChannelRecord,
	model: string | null,
	verifiedModelsByChannel: Map<string, Set<string>>,
): boolean {
	if (!model) {
		return true;
	}
	const metadata = parseChannelMetadata(channel.metadata_json);
	const resolved = resolveUpstreamModelForChannel(
		channel,
		metadata,
		model,
		verifiedModelsByChannel,
	);
	if (!resolved.model) {
		return false;
	}
	const manual = parseManualModelConfig(channel.metadata_json);
	const excludedModels = new Set(manual.exclude);
	const canonicalModel = deriveCanonicalModel(model) ?? model;
	const canonicalResolvedModel =
		deriveCanonicalModel(resolved.model) ?? resolved.model;
	if (
		(canonicalModel && excludedModels.has(canonicalModel)) ||
		(canonicalResolvedModel && excludedModels.has(canonicalResolvedModel))
	) {
		return false;
	}
	if (hasExplicitModelMapping(metadata, model)) {
		return true;
	}
	const knownModels = collectKnownChannelModels(
		channel,
		verifiedModelsByChannel,
	);
	if (knownModels.length === 0) {
		return false;
	}
	return canonicalResolvedModel
		? knownModels.includes(canonicalResolvedModel)
		: false;
}

export function selectCandidateChannels(
	allowedChannels: ChannelRecord[],
	downstreamModel: string | null,
	verifiedModelsByChannel: Map<string, Set<string>> = new Map(),
): ChannelRecord[] {
	return allowedChannels.filter((channel) =>
		channelSupportsModel(channel, downstreamModel, verifiedModelsByChannel),
	);
}

export function buildChannelAttemptModels(options: {
	channel: ChannelRecord;
	metadata?: ChannelMetadata;
	downstreamModel: string | null;
	requestModelRaw: string | null;
	canonicalAliases?: string[];
	preferRequestedModel?: boolean;
}): Array<string | null> {
	const canonicalModel = deriveCanonicalModel(
		options.downstreamModel ?? options.requestModelRaw,
	);
	if (!canonicalModel) {
		return [options.downstreamModel ?? options.requestModelRaw ?? null];
	}
	const metadata =
		options.metadata ?? parseChannelMetadata(options.channel.metadata_json);
	const rawIds = extractModelIds(options.channel);
	const canonicalAliasSet = new Set(
		(options.canonicalAliases ?? [])
			.map((alias) => normalizeAttemptModel(alias))
			.filter((alias): alias is string => Boolean(alias)),
	);
	const candidates: string[] = [];
	const seen = new Set<string>();
	const appendCandidate = (value: string | null | undefined) => {
		const normalized = normalizeAttemptModel(value);
		if (!normalized || seen.has(normalized)) {
			return;
		}
		const allowedByAliasTable =
			canonicalAliasSet.size > 0 && canonicalAliasSet.has(normalized);
		const allowedByHeuristic =
			(deriveCanonicalModel(normalized) ?? normalized) === canonicalModel;
		if (!allowedByAliasTable && !allowedByHeuristic) {
			return;
		}
		seen.add(normalized);
		candidates.push(normalized);
	};
	if (
		options.preferRequestedModel &&
		options.requestModelRaw &&
		rawIds.includes(options.requestModelRaw)
	) {
		appendCandidate(options.requestModelRaw);
	}
	const mappedModel = resolveMappedModel(
		metadata.model_mapping,
		options.downstreamModel,
	);
	if (
		mappedModel &&
		mappedModel !== options.downstreamModel &&
		deriveCanonicalModel(mappedModel) === canonicalModel
	) {
		appendCandidate(mappedModel);
	}
	for (const rawId of rawIds) {
		appendCandidate(rawId);
	}
	return candidates;
}

export function buildChannelAttemptPlan(options: {
	ordered: ChannelRecord[];
	downstreamModel: string | null;
	requestModelRaw: string | null;
	canonicalAliases?: string[];
	downstreamProvider: ProviderType;
	endpointType: EndpointType;
	maxAttempts: number;
}): ChannelAttemptPlanItem[] {
	const plan: ChannelAttemptPlanItem[] = [];
	const seen = new Set<string>();
	for (const [channelIndex, channel] of options.ordered.entries()) {
		const metadata = parseChannelMetadata(channel.metadata_json);
		const models = buildChannelAttemptModels({
			channel,
			metadata,
			downstreamModel: options.downstreamModel,
			requestModelRaw: options.requestModelRaw,
			canonicalAliases: options.canonicalAliases,
			preferRequestedModel: channelIndex === 0,
		});
		const requestFormats = buildRequestEntryFormatAttemptOrder({
			siteType: metadata.site_type,
			entry: metadata.request_entry,
			endpointType: options.endpointType,
		});
		const requestAttempts =
			requestFormats.length > 0
				? requestFormats.map((format) => ({
						requestEntryFormat: format,
						requestEndpointType: resolveEndpointTypeForRequestEntryFormat(
							format,
							options.endpointType,
						),
					}))
				: [
						{
							requestEntryFormat: null,
							requestEndpointType: options.endpointType,
						},
					];
		for (const model of models) {
			for (const requestAttempt of requestAttempts) {
				const key = `${channel.id}::${model ?? ""}::${requestAttempt.requestEntryFormat ?? ""}`;
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				if (plan.length >= options.maxAttempts) {
					return plan;
				}
				plan.push({
					channel,
					model,
					requestEntryFormat: requestAttempt.requestEntryFormat,
					requestEndpointType: requestAttempt.requestEndpointType,
				});
			}
		}
	}
	return plan;
}
