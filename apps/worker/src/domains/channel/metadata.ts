import { safeJsonParse } from "../../utils/json";
import { deriveCanonicalModel } from "../../services/model-normalization";
import {
	type EndpointOverrides,
	parseSiteMetadata,
	type RequestEntry,
	type SiteType,
} from "../../services/site-metadata";
import { resolveUpstreamProvider } from "../../services/upstreams";

export type ProviderType = "openai" | "anthropic" | "gemini";

export type ChannelMetadata = {
	site_type: SiteType;
	endpoint_overrides: EndpointOverrides;
	request_entry: RequestEntry;
	model_mapping: Record<string, string>;
	header_overrides: Record<string, string>;
	query_overrides: Record<string, string>;
};

function normalizeMapping(value: unknown): Record<string, string> {
	if (!value) {
		return {};
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) {
			return {};
		}
		const parsed = safeJsonParse<Record<string, unknown> | null>(trimmed, null);
		return normalizeMapping(parsed);
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	const output: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry === undefined || entry === null) {
			continue;
		}
		const normalizedKey =
			key === "*" ? "*" : (deriveCanonicalModel(String(key)) ?? String(key));
		output[normalizedKey] = String(entry);
	}
	return output;
}

function readMetadataObject(
	raw: string | null | undefined,
): Record<string, unknown> {
	return safeJsonParse<Record<string, unknown>>(raw, {});
}

export function parseChannelMetadata(
	raw: string | null | undefined,
): ChannelMetadata {
	const base = readMetadataObject(raw);
	const site = parseSiteMetadata(raw);
	return {
		site_type: site.site_type,
		endpoint_overrides: site.endpoint_overrides,
		request_entry: site.request_entry,
		model_mapping: normalizeMapping(base.model_mapping),
		header_overrides: normalizeMapping(
			base.header_override ?? base.header_overrides ?? base.headers,
		),
		query_overrides: normalizeMapping(
			base.query_override ?? base.query_overrides ?? base.query,
		),
	};
}

export function resolveProvider(siteType: SiteType): ProviderType {
	return resolveUpstreamProvider(siteType);
}

export function resolveMappedModel(
	modelMapping: Record<string, string>,
	model: string | null,
): string | null {
	if (!model) {
		return modelMapping["*"] ?? null;
	}
	const canonicalModel = deriveCanonicalModel(model) ?? model;
	return modelMapping[canonicalModel] ?? modelMapping["*"] ?? model;
}
