import type { ChannelTokenTestItem } from "../domains/channel/testing";

export type VerifiedTokenModelUpdate = {
	tokenId: string;
	models: string[];
};

export function collectVerifiedTokenModelUpdates(
	tokenResults: ChannelTokenTestItem[],
): VerifiedTokenModelUpdate[] {
	return tokenResults
		.filter(
			(item) =>
				item.ok &&
				typeof item.tokenId === "string" &&
				item.tokenId.trim().length > 0,
		)
		.map((item) => ({
			tokenId: item.tokenId as string,
			models: item.models,
		}));
}
