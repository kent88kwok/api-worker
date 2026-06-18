import type { D1Database } from "@cloudflare/workers-types";
import type { ChannelCallTokenRow } from "./call-token-types";

type ChannelCallTokenFilters = {
	channelIds?: string[] | null;
};

const MAX_SQL_BINDINGS = 90;

const chunkStrings = (items: string[], size: number) => {
	const chunks: string[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
};

export async function listCallTokens(
	db: D1Database,
	filters?: ChannelCallTokenFilters,
): Promise<ChannelCallTokenRow[]> {
	if (filters?.channelIds && filters.channelIds.length === 0) {
		return [];
	}
	if (!filters?.channelIds || filters.channelIds.length <= MAX_SQL_BINDINGS) {
		const bindings = filters?.channelIds ?? [];
		const whereSql =
			bindings.length > 0
				? `WHERE channel_id IN (${bindings.map(() => "?").join(", ")})`
				: "";
		const rows = await db
			.prepare(
				`SELECT * FROM channel_call_tokens ${whereSql} ORDER BY channel_id ASC, priority ASC, created_at ASC, id ASC`,
			)
			.bind(...bindings)
			.all<ChannelCallTokenRow>();
		return rows.results ?? [];
	}
	const merged: ChannelCallTokenRow[] = [];
	for (const chunk of chunkStrings(filters.channelIds, MAX_SQL_BINDINGS)) {
		const placeholders = chunk.map(() => "?").join(", ");
		const rows = await db
			.prepare(
				`SELECT * FROM channel_call_tokens WHERE channel_id IN (${placeholders}) ORDER BY channel_id ASC, priority ASC, created_at ASC, id ASC`,
			)
			.bind(...chunk)
			.all<ChannelCallTokenRow>();
		merged.push(...(rows.results ?? []));
	}
	return merged.sort((left, right) => {
		const channelDiff = String(left.channel_id ?? "").localeCompare(
			String(right.channel_id ?? ""),
		);
		if (channelDiff !== 0) {
			return channelDiff;
		}
		const priorityDiff =
			Number(left.priority ?? 0) - Number(right.priority ?? 0);
		if (priorityDiff !== 0) {
			return priorityDiff;
		}
		const createdAtDiff = String(left.created_at ?? "").localeCompare(
			String(right.created_at ?? ""),
		);
		if (createdAtDiff !== 0) {
			return createdAtDiff;
		}
		return String(left.id ?? "").localeCompare(String(right.id ?? ""));
	});
}

export async function deleteCallTokensByChannelId(
	db: D1Database,
	channelId: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM channel_call_tokens WHERE channel_id = ?")
		.bind(channelId)
		.run();
}

export type ChannelCallTokenInsertInput = {
	id: string;
	channel_id: string;
	name: string;
	api_key: string;
	priority: number;
	created_at: string;
	updated_at: string;
};

export async function insertCallToken(
	db: D1Database,
	input: ChannelCallTokenInsertInput,
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO channel_call_tokens (id, channel_id, name, api_key, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			input.id,
			input.channel_id,
			input.name,
			input.api_key,
			input.priority,
			input.created_at,
			input.updated_at,
		)
		.run();
}

export async function replaceCallTokensForChannel(
	db: D1Database,
	channelId: string,
	tokens: ChannelCallTokenInsertInput[],
): Promise<void> {
	await deleteCallTokensByChannelId(db, channelId);
	for (const token of tokens) {
		await insertCallToken(db, token);
	}
}

export async function updateCallTokenModels(
	db: D1Database,
	tokenId: string,
	models: string[],
	updatedAt: string,
): Promise<void> {
	const modelsJson = models.length > 0 ? JSON.stringify(models) : null;
	await db
		.prepare(
			"UPDATE channel_call_tokens SET models_json = ?, updated_at = ? WHERE id = ?",
		)
		.bind(modelsJson, updatedAt, tokenId)
		.run();
}
