import { normalizeSiteType } from "../../../shared-core/src";
import { safeJsonParse } from "../utils/json";
import { normalizeBaseUrl } from "../utils/url";
export type { SiteType } from "../../../shared-core/src";
import type { SiteType } from "../../../shared-core/src";

export type EndpointOverrides = {
	chat_url?: string | null;
	image_url?: string | null;
	embedding_url?: string | null;
};

export type SiteMetadata = {
	site_type: SiteType;
	endpoint_overrides: EndpointOverrides;
	manual_include_models: string[];
	manual_pending_models: string[];
	manual_exclude_models: string[];
};

const DEFAULT_SITE_TYPE: SiteType = "new-api";

const normalizeOverride = (value: unknown): string | null => {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	return normalizeBaseUrl(trimmed);
};

function normalizeModelList(value: unknown): string[] {
	const output: string[] = [];
	const seen = new Set<string>();
	const append = (item: unknown) => {
		const normalized = String(item ?? "").trim();
		if (!normalized || seen.has(normalized)) {
			return;
		}
		seen.add(normalized);
		output.push(normalized);
	};
	if (Array.isArray(value)) {
		for (const item of value) {
			append(item);
		}
		return output;
	}
	if (typeof value === "string") {
		for (const item of value.split(/[\n,]/)) {
			append(item);
		}
	}
	return output;
}

export function parseSiteMetadata(
	raw: string | null | undefined,
): SiteMetadata {
	const parsed = safeJsonParse<Record<string, unknown>>(raw, {});
	const site_type = normalizeSiteType(parsed.site_type ?? DEFAULT_SITE_TYPE);
	const overrides =
		parsed.endpoint_overrides && typeof parsed.endpoint_overrides === "object"
			? (parsed.endpoint_overrides as Record<string, unknown>)
			: {};
	return {
		site_type,
		endpoint_overrides: {
			chat_url: normalizeOverride(overrides.chat_url),
			image_url: normalizeOverride(overrides.image_url),
			embedding_url: normalizeOverride(overrides.embedding_url),
		},
		manual_include_models: normalizeModelList(parsed.manual_include_models),
		manual_pending_models: normalizeModelList(parsed.manual_pending_models),
		manual_exclude_models: normalizeModelList(parsed.manual_exclude_models),
	};
}

export function buildSiteMetadata(
	existing: string | null | undefined,
	updates: {
		site_type?: SiteType;
		endpoint_overrides?: EndpointOverrides | null;
		manual_include_models?: unknown;
		manual_exclude_models?: unknown;
	},
): string | null {
	const base = safeJsonParse<Record<string, unknown>>(existing, {});
	if (updates.site_type) {
		base.site_type = updates.site_type;
	}
	if (updates.endpoint_overrides) {
		base.endpoint_overrides = {
			chat_url: normalizeOverride(updates.endpoint_overrides.chat_url),
			image_url: normalizeOverride(updates.endpoint_overrides.image_url),
			embedding_url: normalizeOverride(
				updates.endpoint_overrides.embedding_url,
			),
		};
	}
	if (updates.manual_include_models !== undefined) {
		const models = normalizeModelList(updates.manual_include_models);
		if (models.length > 0) {
			base.manual_include_models = models;
		} else {
			delete base.manual_include_models;
		}
	}
	if (updates.manual_exclude_models !== undefined) {
		const models = normalizeModelList(updates.manual_exclude_models);
		if (models.length > 0) {
			base.manual_exclude_models = models;
		} else {
			delete base.manual_exclude_models;
		}
	}
	return Object.keys(base).length > 0 ? JSON.stringify(base) : null;
}
