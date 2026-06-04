import type { UpstreamDescriptor } from "./types";

export const geminiUpstreamDescriptor: UpstreamDescriptor = {
	siteType: "gemini",
	label: "Gemini",
	defaultProvider: "gemini",
	defaultBaseUrl: "https://generativelanguage.googleapis.com",
	supportsCheckin: false,
	supportsSystemCredentials: false,
	supportedRequestEntryFormats: ["gemini_generate_content"],
};
