import type { UpstreamDescriptor } from "./types";

export const openAiUpstreamDescriptor: UpstreamDescriptor = {
	siteType: "openai",
	label: "OpenAI",
	defaultProvider: "openai",
	defaultBaseUrl: "https://api.openai.com",
	supportsCheckin: false,
	supportsSystemCredentials: false,
	supportedRequestEntryFormats: ["openai_chat", "openai_responses"],
};
