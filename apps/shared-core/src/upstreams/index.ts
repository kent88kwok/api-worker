import { anthropicUpstreamDescriptor } from "./anthropic";
import { doneHubUpstreamDescriptor } from "./done-hub";
import { geminiUpstreamDescriptor } from "./gemini";
import { newApiUpstreamDescriptor } from "./new-api";
import { openAiUpstreamDescriptor } from "./openai";
import { subApiUpstreamDescriptor } from "./subapi";
import type {
	ProviderType,
	RequestEntryFormat,
	SiteType,
	UpstreamDescriptor,
} from "./types";

const descriptors: UpstreamDescriptor[] = [
	newApiUpstreamDescriptor,
	doneHubUpstreamDescriptor,
	subApiUpstreamDescriptor,
	openAiUpstreamDescriptor,
	anthropicUpstreamDescriptor,
	geminiUpstreamDescriptor,
];

export function isSiteType(value: unknown): value is SiteType {
	return (
		value === "new-api" ||
		value === "done-hub" ||
		value === "subapi" ||
		value === "openai" ||
		value === "anthropic" ||
		value === "gemini"
	);
}

export function normalizeSiteType(value: unknown): SiteType {
	if (isSiteType(value)) {
		return value;
	}
	if (value === "custom") {
		return "subapi";
	}
	return "new-api";
}

export function getUpstreamDescriptor(siteType: SiteType): UpstreamDescriptor {
	return (
		descriptors.find((descriptor) => descriptor.siteType === siteType) ??
		newApiUpstreamDescriptor
	);
}

export function getSiteTypeLabel(siteType: SiteType): string {
	return getUpstreamDescriptor(siteType).label;
}

export function getDefaultBaseUrlForSiteType(
	siteType: SiteType,
): string | undefined {
	return getUpstreamDescriptor(siteType).defaultBaseUrl;
}

export function supportsSiteCheckin(siteType: SiteType): boolean {
	return getUpstreamDescriptor(siteType).supportsCheckin;
}

export function supportsSystemCredentials(siteType: SiteType): boolean {
	return getUpstreamDescriptor(siteType).supportsSystemCredentials;
}

export function getSupportedRequestEntryFormatsForSiteType(
	siteType: SiteType,
): RequestEntryFormat[] {
	return [...getUpstreamDescriptor(siteType).supportedRequestEntryFormats];
}

export function isRequestEntryFormatAllowedForSiteType(
	siteType: SiteType,
	format: string,
): boolean {
	if (!format) {
		return true;
	}
	return getSupportedRequestEntryFormatsForSiteType(siteType).includes(
		format as RequestEntryFormat,
	);
}

export function resolveDefaultProviderForSiteType(
	siteType: SiteType,
): ProviderType {
	return getUpstreamDescriptor(siteType).defaultProvider;
}

export {
	anthropicUpstreamDescriptor,
	doneHubUpstreamDescriptor,
	geminiUpstreamDescriptor,
	newApiUpstreamDescriptor,
	openAiUpstreamDescriptor,
	subApiUpstreamDescriptor,
};

export type { ProviderType, RequestEntryFormat, SiteType, UpstreamDescriptor };
