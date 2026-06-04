import type { SiteType } from "../site-metadata";
import type { EndpointType, ProviderType } from "../provider-transform";
import {
	resolveEndpointTypeForRequestEntryFormat,
	resolveUpstreamProviderForRequestEntryFormat,
} from "../request-entry-attempts";
import { applyCustomRequestEntry } from "./custom-request-entry";
import type { RequestEntry, RequestEntryFormat } from "../site-metadata";

export type AttemptRequestBuildStrategy =
	| "reuse_custom_entry_body"
	| "rewrite_model"
	| "rebuild_chat"
	| "rebuild_embedding"
	| "rebuild_image";

export type AttemptRequestBuildPlan = {
	upstreamProvider: ProviderType;
	requestEndpointType: EndpointType;
	strategy: AttemptRequestBuildStrategy;
	customEntry:
		| {
				path?: string;
				absoluteUrl?: string;
				upstreamProvider: ProviderType;
				requestEntryFormatToPersist?: RequestEntryFormat;
		  }
		| null
		| undefined;
	requestEntryFormatToPersist?: RequestEntryFormat;
};

export function resolveAttemptRequestBuildPlan(options: {
	attemptUpstreamProvider: ProviderType;
	siteType: SiteType;
	requestEntry?: RequestEntry | null;
	downstreamProvider: ProviderType;
	endpointType: EndpointType;
	requestEntryFormatOverride?: RequestEntryFormat | null;
}): AttemptRequestBuildPlan | null {
	let upstreamProvider = resolveUpstreamProviderForRequestEntryFormat(
		options.requestEntryFormatOverride ?? null,
		options.attemptUpstreamProvider,
	);
	const requestEndpointType = resolveEndpointTypeForRequestEntryFormat(
		options.requestEntryFormatOverride ?? null,
		options.endpointType,
	);
	const customEntry = applyCustomRequestEntry({
		siteType: options.siteType,
		entry: options.requestEntry,
		downstreamProvider: options.downstreamProvider,
		endpointType: options.endpointType,
		formatOverride: options.requestEntryFormatOverride,
	});
	if (customEntry === null) {
		return null;
	}
	if (customEntry) {
		upstreamProvider = customEntry.upstreamProvider;
	}

	const sameProvider = upstreamProvider === options.downstreamProvider;
	const isChatLike =
		options.endpointType === "chat" || options.endpointType === "responses";
	const shouldRebuildChatRequest =
		(options.requestEntryFormatOverride !== null &&
			options.requestEntryFormatOverride !== undefined &&
			isChatLike) ||
		(!sameProvider && isChatLike);

	if (customEntry && !shouldRebuildChatRequest) {
		return {
			upstreamProvider,
			requestEndpointType,
			strategy: "reuse_custom_entry_body",
			customEntry,
			requestEntryFormatToPersist: customEntry.requestEntryFormatToPersist,
		};
	}

	if (sameProvider) {
		return {
			upstreamProvider,
			requestEndpointType,
			strategy: "rewrite_model",
			customEntry,
			requestEntryFormatToPersist: customEntry?.requestEntryFormatToPersist,
		};
	}

	if (options.endpointType === "chat" || options.endpointType === "responses") {
		return {
			upstreamProvider,
			requestEndpointType,
			strategy: "rebuild_chat",
			customEntry,
			requestEntryFormatToPersist: customEntry?.requestEntryFormatToPersist,
		};
	}
	if (options.endpointType === "embeddings") {
		return {
			upstreamProvider,
			requestEndpointType,
			strategy: "rebuild_embedding",
			customEntry,
			requestEntryFormatToPersist: customEntry?.requestEntryFormatToPersist,
		};
	}
	if (options.endpointType === "images") {
		return {
			upstreamProvider,
			requestEndpointType,
			strategy: "rebuild_image",
			customEntry,
			requestEntryFormatToPersist: customEntry?.requestEntryFormatToPersist,
		};
	}
	return null;
}
