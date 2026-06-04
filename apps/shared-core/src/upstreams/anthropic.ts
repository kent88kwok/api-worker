import type { UpstreamDescriptor } from "./types";

export const anthropicUpstreamDescriptor: UpstreamDescriptor = {
	siteType: "anthropic",
	label: "Anthropic",
	defaultProvider: "anthropic",
	defaultBaseUrl: "https://api.anthropic.com",
	supportsCheckin: false,
	supportsSystemCredentials: false,
	supportedRequestEntryFormats: ["anthropic_messages"],
};
