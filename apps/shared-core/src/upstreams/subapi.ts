import type { UpstreamDescriptor } from "./types";

export const subApiUpstreamDescriptor: UpstreamDescriptor = {
	siteType: "subapi",
	label: "Sub API",
	defaultProvider: "openai",
	supportsCheckin: false,
	supportsSystemCredentials: true,
	supportedRequestEntryFormats: [
		"openai_chat",
		"openai_responses",
		"anthropic_messages",
		"gemini_generate_content",
	],
};
