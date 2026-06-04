import {
	canRequestEntryFormatHandleDownstream,
	getRequestEntryFormatDefaultPath,
	isRequestEntryEndpointType,
	resolveRequestEntryFormatUpstreamProvider,
} from "../../../../shared-core/src";
import type { EndpointType, ProviderType } from "../provider-transform";
import { buildRequestEntryFormatAttemptOrder } from "../request-entry-attempts";
import type { SiteType } from "../site-metadata";
import type { RequestEntry, RequestEntryFormat } from "../site-metadata";

export function applyCustomRequestEntry(options: {
	siteType: SiteType;
	entry?: RequestEntry | null;
	downstreamProvider: ProviderType;
	endpointType: EndpointType;
	formatOverride?: RequestEntryFormat | null;
}):
	| {
			path?: string;
			absoluteUrl?: string;
			upstreamProvider: ProviderType;
			requestEntryFormatToPersist?: RequestEntryFormat;
	  }
	| null
	| undefined {
	const entry = options.entry;
	if (!entry?.path && !entry?.format) {
		return undefined;
	}
	if (!options.downstreamProvider) {
		throw new Error("downstreamProvider is required");
	}
	const effectiveFormat =
		options.formatOverride ??
		buildRequestEntryFormatAttemptOrder({
			siteType: options.siteType,
			entry,
			endpointType: options.endpointType,
		})[0] ??
		null;
	if (!effectiveFormat) {
		return null;
	}
	const downstreamEndpointType = isRequestEntryEndpointType(
		options.endpointType,
	)
		? options.endpointType
		: null;
	if (!downstreamEndpointType) {
		return null;
	}
	const acceptsRequest = canRequestEntryFormatHandleDownstream({
		format: effectiveFormat,
		downstreamProvider: options.downstreamProvider,
		endpointType: downstreamEndpointType,
		allowEndpointOverride: Boolean(options.formatOverride),
	});
	if (!acceptsRequest) {
		return null;
	}
	const upstreamProvider =
		resolveRequestEntryFormatUpstreamProvider(effectiveFormat);
	const requestEntryFormatToPersist =
		entry.format || options.formatOverride ? undefined : effectiveFormat;
	const resolvedPath =
		entry.path ?? getRequestEntryFormatDefaultPath(effectiveFormat);
	if (
		resolvedPath &&
		(resolvedPath.startsWith("http://") || resolvedPath.startsWith("https://"))
	) {
		return {
			absoluteUrl: resolvedPath,
			upstreamProvider,
			requestEntryFormatToPersist,
		};
	}
	return {
		path: resolvedPath,
		upstreamProvider,
		requestEntryFormatToPersist,
	};
}
