import type { D1Database } from "@cloudflare/workers-types";
import { listEffectiveModelEntries } from "../domains/channel/effective-models";
import type { ChannelRow } from "../domains/channel/types";

export type OpenAiModelListItem = {
	id: string;
	object: "model";
	created: number;
	owned_by: string;
};

export type OpenAiModelListPayload = {
	object: "list";
	data: OpenAiModelListItem[];
};

const MODEL_CREATED_AT = 0;
const MODEL_OWNER = "api-worker";

export function buildOpenAiModelListPayload(
	modelIds: string[],
): OpenAiModelListPayload {
	const seen = new Set<string>();
	const data: OpenAiModelListItem[] = [];

	for (const modelId of modelIds) {
		const id = String(modelId).trim();
		if (!id || seen.has(id)) {
			continue;
		}
		seen.add(id);
		data.push({
			id,
			object: "model",
			created: MODEL_CREATED_AT,
			owned_by: MODEL_OWNER,
		});
	}

	return {
		object: "list",
		data,
	};
}

export async function listOpenAiModelsForChannels(
	db: D1Database,
	channels: Array<
		Pick<ChannelRow, "id" | "name" | "models_json" | "metadata_json">
	>,
): Promise<OpenAiModelListPayload> {
	const entries = await listEffectiveModelEntries(db, channels);
	return buildOpenAiModelListPayload(entries.map((entry) => entry.id));
}
