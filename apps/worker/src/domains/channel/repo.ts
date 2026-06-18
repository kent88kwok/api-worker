import type { D1Database } from "@cloudflare/workers-types";
import type { ChannelRow } from "./types";

type ChannelFilters = {
	status?: string | null;
	type?: number | null;
};

type ChannelOrderBy = "priority" | "created_at" | "id";

const ORDER_COLUMNS: Record<ChannelOrderBy, string> = {
	priority: "priority",
	created_at: "created_at",
	id: "id",
};

function bindIfNeeded<T>(
	stmt: { bind: (...args: Array<string | number>) => T } | T,
	bindings: Array<string | number>,
): T {
	if (bindings.length === 0) {
		return stmt as T;
	}
	return (stmt as { bind: (...args: Array<string | number>) => T }).bind(
		...bindings,
	);
}

function buildWhere(filters: ChannelFilters | undefined) {
	const where: string[] = [];
	const bindings: Array<string | number> = [];
	if (filters?.status) {
		where.push("status = ?");
		bindings.push(filters.status);
	}
	if (filters?.type !== undefined && filters?.type !== null) {
		where.push("type = ?");
		bindings.push(filters.type);
	}
	const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	return { whereSql, bindings };
}

export async function listChannels(
	db: D1Database,
	options: {
		filters?: ChannelFilters;
		orderBy?: ChannelOrderBy;
		order?: "ASC" | "DESC";
		limit?: number;
		offset?: number;
	} = {},
): Promise<ChannelRow[]> {
	const { whereSql, bindings } = buildWhere(options.filters);
	const orderBy = options.orderBy ?? "created_at";
	const order = options.order ?? "DESC";
	const orderSql = `ORDER BY ${ORDER_COLUMNS[orderBy]} ${order}`;
	const limitSql =
		options.limit !== undefined && options.offset !== undefined
			? "LIMIT ? OFFSET ?"
			: "";
	const limitBindings =
		options.limit !== undefined && options.offset !== undefined
			? [options.limit, options.offset]
			: [];

	const statement = db.prepare(
		`SELECT * FROM channels ${whereSql} ${orderSql} ${limitSql}`,
	);
	const rows = await bindIfNeeded(statement, [
		...bindings,
		...limitBindings,
	]).all<ChannelRow>();
	return rows.results ?? [];
}

export async function countChannels(
	db: D1Database,
	filters?: ChannelFilters,
): Promise<number> {
	const { whereSql, bindings } = buildWhere(filters);
	const statement = db.prepare(
		`SELECT COUNT(*) as count FROM channels ${whereSql}`,
	);
	const row = await bindIfNeeded(statement, bindings).first<{
		count: number;
	}>();
	return Number(row?.count ?? 0);
}

export async function countChannelsByType(
	db: D1Database,
	filters?: ChannelFilters,
): Promise<Record<string, number>> {
	const { whereSql, bindings } = buildWhere(filters);
	const statement = db.prepare(
		`SELECT type, COUNT(*) as count FROM channels ${whereSql} GROUP BY type`,
	);
	const counts = await bindIfNeeded(statement, bindings).all();
	const result: Record<string, number> = {};
	for (const entry of counts.results ?? []) {
		result[String((entry as { type?: unknown }).type)] = Number(
			(entry as { count?: unknown }).count ?? 0,
		);
	}
	return result;
}

export async function listActiveChannels(
	db: D1Database,
): Promise<ChannelRow[]> {
	const nowSeconds = Math.floor(Date.now() / 1000);
	const rows = await db
		.prepare(
			"SELECT * FROM channels WHERE status = ? AND COALESCE(auto_disabled_permanent, 0) = 0 AND (auto_disabled_until IS NULL OR auto_disabled_until <= ?)",
		)
		.bind("active", nowSeconds)
		.all<ChannelRow>();
	return rows.results ?? [];
}

export async function getChannelById(
	db: D1Database,
	id: string,
): Promise<ChannelRow | null> {
	const row = await db
		.prepare("SELECT * FROM channels WHERE id = ?")
		.bind(id)
		.first<ChannelRow>();
	return row ?? null;
}

export async function channelExists(
	db: D1Database,
	id: string,
): Promise<boolean> {
	const row = await db
		.prepare("SELECT id FROM channels WHERE id = ?")
		.bind(id)
		.first<{ id: string }>();
	return Boolean(row?.id);
}

export type ChannelInsertInput = {
	id: string;
	name: string;
	base_url: string;
	api_key: string;
	weight: number;
	status: string;
	rate_limit: number;
	models_json: string;
	type: number;
	group_name: string | null;
	priority: number;
	metadata_json: string | null;
	system_token?: string | null;
	system_userid?: string | null;
	checkin_enabled?: number | boolean | null;
	checkin_url?: string | null;
	last_checkin_date?: string | null;
	last_checkin_status?: string | null;
	last_checkin_message?: string | null;
	last_checkin_at?: string | null;
	created_at: string;
	updated_at: string;
};

export async function insertChannel(
	db: D1Database,
	input: ChannelInsertInput,
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO channels (id, name, base_url, api_key, weight, status, rate_limit, models_json, type, group_name, priority, metadata_json, system_token, system_userid, checkin_enabled, checkin_url, last_checkin_date, last_checkin_status, last_checkin_message, last_checkin_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			input.id,
			input.name,
			input.base_url,
			input.api_key,
			input.weight,
			input.status,
			input.rate_limit,
			input.models_json,
			input.type,
			input.group_name,
			input.priority,
			input.metadata_json,
			input.system_token ?? null,
			input.system_userid ?? null,
			typeof input.checkin_enabled === "boolean"
				? input.checkin_enabled
					? 1
					: 0
				: (input.checkin_enabled ?? 0),
			input.checkin_url ?? null,
			input.last_checkin_date ?? null,
			input.last_checkin_status ?? null,
			input.last_checkin_message ?? null,
			input.last_checkin_at ?? null,
			input.created_at,
			input.updated_at,
		)
		.run();
}

export type ChannelUpdateInput = {
	name: string;
	base_url: string;
	api_key: string;
	weight: number;
	status: string;
	rate_limit: number;
	models_json: string;
	type: number;
	group_name: string | null;
	priority: number;
	metadata_json: string | null;
	system_token: string | null;
	system_userid: string | null;
	checkin_enabled: number | boolean | null;
	checkin_url: string | null;
	last_checkin_date: string | null;
	last_checkin_status: string | null;
	last_checkin_message: string | null;
	last_checkin_at: string | null;
	updated_at: string;
};

export async function updateChannel(
	db: D1Database,
	id: string,
	input: ChannelUpdateInput,
): Promise<void> {
	await db
		.prepare(
			"UPDATE channels SET name = ?, base_url = ?, api_key = ?, weight = ?, status = ?, rate_limit = ?, models_json = ?, type = ?, group_name = ?, priority = ?, metadata_json = ?, system_token = ?, system_userid = ?, checkin_enabled = ?, checkin_url = ?, last_checkin_date = ?, last_checkin_status = ?, last_checkin_message = ?, last_checkin_at = ?, updated_at = ? WHERE id = ?",
		)
		.bind(
			input.name,
			input.base_url,
			input.api_key,
			input.weight,
			input.status,
			input.rate_limit,
			input.models_json,
			input.type,
			input.group_name,
			input.priority,
			input.metadata_json,
			input.system_token,
			input.system_userid,
			typeof input.checkin_enabled === "boolean"
				? input.checkin_enabled
					? 1
					: 0
				: (input.checkin_enabled ?? 0),
			input.checkin_url,
			input.last_checkin_date,
			input.last_checkin_status,
			input.last_checkin_message,
			input.last_checkin_at,
			input.updated_at,
			id,
		)
		.run();
}

export async function updateChannelCheckinResult(
	db: D1Database,
	id: string,
	input: {
		last_checkin_date: string | null;
		last_checkin_status: string | null;
		last_checkin_message: string | null;
		last_checkin_at: string | null;
	},
): Promise<void> {
	await db
		.prepare(
			"UPDATE channels SET last_checkin_date = ?, last_checkin_status = ?, last_checkin_message = ?, last_checkin_at = ?, updated_at = ? WHERE id = ?",
		)
		.bind(
			input.last_checkin_date,
			input.last_checkin_status,
			input.last_checkin_message,
			input.last_checkin_at,
			input.last_checkin_at ?? new Date().toISOString(),
			id,
		)
		.run();
}

export async function deleteChannel(db: D1Database, id: string): Promise<void> {
	await db.prepare("DELETE FROM channels WHERE id = ?").bind(id).run();
}
