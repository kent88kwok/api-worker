import { transformOpenAiStreamOptions } from "./usage-observe";
import { shouldHandleOpenAiStreamOptions } from "./stream-options";

export async function applyAttemptStreamOptionsPolicy(options: {
	channelId: string;
	upstreamProvider: string;
	isStream: boolean;
	endpointType: string;
	shouldSkipHeavyBodyParsing: boolean;
	bodyText?: string;
	loadStreamOptionsCapability: (
		channelId: string,
	) => Promise<"supported" | "unsupported" | "unknown">;
}): Promise<{
	streamOptionsHandled: boolean;
	streamOptionsInjected: boolean;
	bodyText?: string;
	strippedBodyText?: string;
}> {
	const shouldHandleStreamOptions = shouldHandleOpenAiStreamOptions({
		upstreamProvider: options.upstreamProvider,
		isStream: options.isStream,
		endpointType: options.endpointType,
		shouldSkipHeavyBodyParsing: options.shouldSkipHeavyBodyParsing,
	});
	let upstreamBodyText = options.bodyText;
	let streamOptionsInjected = false;
	let strippedStreamOptionsBodyText: string | undefined = upstreamBodyText;

	if (shouldHandleStreamOptions) {
		const capability = await options.loadStreamOptionsCapability(
			options.channelId,
		);
		if (capability !== "unsupported") {
			const injected = transformOpenAiStreamOptions(upstreamBodyText, "inject");
			upstreamBodyText = injected.bodyText;
			streamOptionsInjected = injected.injected;
			const stripped = transformOpenAiStreamOptions(upstreamBodyText, "strip");
			strippedStreamOptionsBodyText = stripped.bodyText;
		} else {
			const stripped = transformOpenAiStreamOptions(upstreamBodyText, "strip");
			upstreamBodyText = stripped.bodyText;
			strippedStreamOptionsBodyText = stripped.bodyText;
		}
	}

	return {
		streamOptionsHandled: shouldHandleStreamOptions,
		streamOptionsInjected,
		bodyText: upstreamBodyText,
		strippedBodyText: strippedStreamOptionsBodyText,
	};
}
