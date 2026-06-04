import {
	buildAutomaticRequestEntryFormatOrder,
	getRequestEntryFormatRequestEndpointType,
	getSupportedRequestEntryFormatsForSiteType,
	resolveRequestEntryFormatUpstreamProvider,
	type SiteType,
} from "../../../shared-core/src";
import type { EndpointType, ProviderType } from "./provider-transform";
import type { RequestEntry, RequestEntryFormat } from "./site-metadata";

export function resolveEndpointTypeForRequestEntryFormat(
	format: RequestEntryFormat | null,
	fallbackEndpointType: EndpointType,
): EndpointType {
	return format
		? getRequestEntryFormatRequestEndpointType(format)
		: fallbackEndpointType;
}

export function resolveUpstreamProviderForRequestEntryFormat(
	format: RequestEntryFormat | null,
	fallbackProvider: ProviderType,
): ProviderType {
	return format
		? resolveRequestEntryFormatUpstreamProvider(format)
		: fallbackProvider;
}

function isFormatCompatibleWithEndpointType(
	format: RequestEntryFormat,
	endpointType: EndpointType,
): boolean {
	return endpointType === "chat" || endpointType === "responses";
}

function buildAutomaticFormatOrder(
	siteType: SiteType,
	endpointType: EndpointType,
): RequestEntryFormat[] {
	const supportedFormats = getSupportedRequestEntryFormatsForSiteType(
		siteType,
	).filter((format) =>
		isFormatCompatibleWithEndpointType(format, endpointType),
	);
	if (endpointType !== "responses") {
		return supportedFormats;
	}
	return buildAutomaticRequestEntryFormatOrder({
		formats: supportedFormats,
		endpointType,
	});
}

export function buildRequestEntryFormatAttemptOrder(options: {
	siteType: SiteType;
	entry?: RequestEntry | null;
	endpointType: EndpointType;
}): RequestEntryFormat[] {
	const explicitFormat = options.entry?.format ?? null;
	if (explicitFormat) {
		return [explicitFormat];
	}
	return buildAutomaticFormatOrder(options.siteType, options.endpointType);
}
