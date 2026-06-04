import type { ProviderType, RequestEntryFormat } from "./upstreams/types";

export type RequestEntryEndpointType = "chat" | "responses";

export type RequestEntryFormatDescriptor = {
	format: RequestEntryFormat;
	label: string;
	upstreamProvider: ProviderType;
	requestEndpointType: RequestEntryEndpointType;
	defaultPath?: string;
	aliases: string[];
	automaticPriority: Record<RequestEntryEndpointType, number>;
};

const requestEntryFormatDescriptors: RequestEntryFormatDescriptor[] = [
	{
		format: "openai_chat",
		label: "OpenAI Chat",
		upstreamProvider: "openai",
		requestEndpointType: "chat",
		defaultPath: "/v1/chat/completions",
		aliases: ["openai_chat", "chat", "chat_completions"],
		automaticPriority: { chat: 10, responses: 20 },
	},
	{
		format: "openai_responses",
		label: "OpenAI Responses",
		upstreamProvider: "openai",
		requestEndpointType: "responses",
		defaultPath: "/v1/responses",
		aliases: ["openai_responses", "responses"],
		automaticPriority: { chat: 20, responses: 10 },
	},
	{
		format: "anthropic_messages",
		label: "Anthropic Messages",
		upstreamProvider: "anthropic",
		requestEndpointType: "chat",
		defaultPath: "/v1/messages",
		aliases: ["anthropic_messages", "anthropic", "messages"],
		automaticPriority: { chat: 30, responses: 30 },
	},
	{
		format: "gemini_generate_content",
		label: "Gemini Generate Content",
		upstreamProvider: "gemini",
		requestEndpointType: "chat",
		aliases: ["gemini_generate_content", "gemini", "generate_content"],
		automaticPriority: { chat: 40, responses: 40 },
	},
];

const requestEntryFormatDescriptorMap: Record<
	RequestEntryFormat,
	RequestEntryFormatDescriptor
> = Object.fromEntries(
	requestEntryFormatDescriptors.map((descriptor) => [
		descriptor.format,
		descriptor,
	]),
) as Record<RequestEntryFormat, RequestEntryFormatDescriptor>;

export function getRequestEntryFormatDescriptor(
	format: RequestEntryFormat,
): RequestEntryFormatDescriptor {
	return requestEntryFormatDescriptorMap[format];
}

export function getRequestEntryFormatLabel(format: RequestEntryFormat): string {
	return getRequestEntryFormatDescriptor(format).label;
}

export function getRequestEntryFormatRequestEndpointType(
	format: RequestEntryFormat,
): RequestEntryEndpointType {
	return getRequestEntryFormatDescriptor(format).requestEndpointType;
}

export function isRequestEntryEndpointType(
	value: string,
): value is RequestEntryEndpointType {
	return value === "chat" || value === "responses";
}

export function resolveRequestEntryFormatUpstreamProvider(
	format: RequestEntryFormat,
): ProviderType {
	return getRequestEntryFormatDescriptor(format).upstreamProvider;
}

export function getRequestEntryFormatDefaultPath(
	format: RequestEntryFormat,
): string | undefined {
	return getRequestEntryFormatDescriptor(format).defaultPath;
}

export function canRequestEntryFormatHandleDownstream(options: {
	format: RequestEntryFormat;
	downstreamProvider: ProviderType;
	endpointType: RequestEntryEndpointType;
	allowEndpointOverride?: boolean;
}): boolean {
	const descriptor = getRequestEntryFormatDescriptor(options.format);
	const endpointTypeToCheck = options.allowEndpointOverride
		? descriptor.requestEndpointType
		: options.endpointType;
	return (
		descriptor.upstreamProvider === options.downstreamProvider &&
		descriptor.requestEndpointType === endpointTypeToCheck
	);
}

export function getRequestEntryFormatDescriptors(): RequestEntryFormatDescriptor[] {
	return [...requestEntryFormatDescriptors];
}

export function normalizeRequestEntryFormat(
	value: unknown,
): RequestEntryFormat | null {
	const normalized = String(value ?? "")
		.trim()
		.toLowerCase();
	if (!normalized) {
		return null;
	}
	return (
		requestEntryFormatDescriptors.find((descriptor) =>
			descriptor.aliases.includes(normalized),
		)?.format ?? null
	);
}

export function buildAutomaticRequestEntryFormatOrder(options: {
	formats: RequestEntryFormat[];
	endpointType: RequestEntryEndpointType;
}): RequestEntryFormat[] {
	return [...options.formats].sort((left, right) => {
		const leftPriority =
			getRequestEntryFormatDescriptor(left).automaticPriority[
				options.endpointType
			];
		const rightPriority =
			getRequestEntryFormatDescriptor(right).automaticPriority[
				options.endpointType
			];
		return leftPriority - rightPriority;
	});
}
