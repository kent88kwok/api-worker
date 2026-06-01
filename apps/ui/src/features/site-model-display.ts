import type { ModelItem } from "../core/types";

export type ModelSquareRow = {
	model: string;
	channels: string[];
};

export type SiteSubmitMode = "create" | "edit";

export function getModelSquareRows(
	models: ModelItem[],
	options: {
		models?: string[];
		channels?: string[];
	} = {},
): ModelSquareRow[] {
	const modelSet =
		options.models && options.models.length > 0
			? new Set(options.models)
			: null;
	const channelSet =
		options.channels && options.channels.length > 0
			? new Set(options.channels)
			: null;
	return models
		.filter((model) => (modelSet ? modelSet.has(model.id) : true))
		.map((model) => {
			const channels = model.channels
				.filter((channel) => (channelSet ? channelSet.has(channel.id) : true))
				.map((channel) => channel.name || channel.id)
				.sort((left, right) => left.localeCompare(right));
			return {
				model: model.id,
				channels,
			};
		})
		.filter((row) => (channelSet ? row.channels.length > 0 : true));
}

export function shouldVerifyAfterSiteSubmit(mode: SiteSubmitMode): boolean {
	return mode === "create";
}
