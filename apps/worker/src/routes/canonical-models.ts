import { Hono } from "hono";
import type { AppEnv } from "../env";
import { triggerBackupAfterDataChange } from "../services/backup-auto-sync";
import { planCanonicalModelCleanup } from "../services/canonical-model-cleanup";
import { syncCanonicalModelAliases } from "../services/canonical-model-registry";
import { jsonError } from "../utils/http";
import { nowIso } from "../utils/time";

const canonicalModels = new Hono<AppEnv>();

type CanonicalModelRow = {
	canonical_model: string;
	display_name: string;
	provider_hint: string | null;
	import_regex: string | null;
	created_at: string;
	updated_at: string;
};

type CanonicalModelAliasRow = {
	alias: string;
	provider_hint: string;
	canonical_model: string;
};

type CanonicalModelItem = {
	canonical_model: string;
	import_regex: string | null;
	aliases: Array<{
		alias: string;
		provider_hint: string;
		canonical_model: string;
	}>;
	created_at: string;
	updated_at: string;
};

function normalizeText(value: unknown): string {
	return String(value ?? "")
		.trim()
		.toLowerCase();
}

function normalizePattern(value: unknown): string | null {
	const text = String(value ?? "").trim();
	return text || null;
}

function parseAliases(value: unknown, fallback: string): string[] {
	const raw = String(value ?? "");
	const items = raw
		.split(/\r?\n/)
		.map((item) => normalizeText(item))
		.filter(Boolean);
	const merged = new Set<string>(items);
	merged.add(normalizeText(fallback));
	return Array.from(merged.values()).sort((left, right) =>
		left.localeCompare(right),
	);
}

async function listCanonicalModelItems(
	db: AppEnv["Bindings"]["DB"],
): Promise<CanonicalModelItem[]> {
	const [registry, aliases] = await Promise.all([
		db
			.prepare(
				[
					"SELECT canonical_model, display_name, provider_hint, import_regex, created_at, updated_at",
					"FROM model_registry ORDER BY updated_at DESC, canonical_model ASC",
				].join(" "),
			)
			.all<CanonicalModelRow>(),
		db
			.prepare(
				[
					"SELECT alias, provider_hint, canonical_model FROM model_aliases",
					"WHERE provider_hint = ''",
					"ORDER BY canonical_model ASC, alias ASC",
				].join(" "),
			)
			.all<CanonicalModelAliasRow>(),
	]);
	const cleanupTargets = new Set(
		planCanonicalModelCleanup({
			registryRows: registry.results ?? [],
			aliasRows: aliases.results ?? [],
		}).map((item) => item.canonical_model),
	);
	const aliasMap = new Map<string, CanonicalModelItem["aliases"]>();
	for (const row of aliases.results ?? []) {
		const list = aliasMap.get(row.canonical_model) ?? [];
		list.push({
			alias: row.alias,
			provider_hint: row.provider_hint,
			canonical_model: row.canonical_model,
		});
		aliasMap.set(row.canonical_model, list);
	}
	return (registry.results ?? [])
		.map((row) => ({
			canonical_model: row.canonical_model,
			import_regex: row.import_regex ?? null,
			aliases: aliasMap.get(row.canonical_model) ?? [],
			created_at: row.created_at,
			updated_at: row.updated_at,
		}))
		.filter((item) => !cleanupTargets.has(item.canonical_model));
}

async function listCanonicalModelCleanupItems(db: AppEnv["Bindings"]["DB"]) {
	const [registry, aliases] = await Promise.all([
		db
			.prepare(
				[
					"SELECT canonical_model, display_name, provider_hint, import_regex, created_at, updated_at",
					"FROM model_registry ORDER BY updated_at DESC, canonical_model ASC",
				].join(" "),
			)
			.all<CanonicalModelRow>(),
		db
			.prepare(
				[
					"SELECT alias, provider_hint, canonical_model FROM model_aliases",
					"WHERE provider_hint = ''",
					"ORDER BY canonical_model ASC, alias ASC",
				].join(" "),
			)
			.all<CanonicalModelAliasRow>(),
	]);
	return planCanonicalModelCleanup({
		registryRows: registry.results ?? [],
		aliasRows: aliases.results ?? [],
	});
}

async function ensureCanonicalModelBaseRows(
	db: AppEnv["Bindings"]["DB"],
	canonicalModel: string,
	importRegex: string | null,
) {
	const timestamp = nowIso();
	await db
		.prepare(
			[
				"INSERT INTO model_registry",
				"(canonical_model, display_name, provider_hint, import_regex, created_at, updated_at)",
				"VALUES (?, ?, NULL, ?, ?, ?)",
				"ON CONFLICT(canonical_model) DO UPDATE SET",
				"display_name = excluded.display_name,",
				"import_regex = excluded.import_regex,",
				"updated_at = excluded.updated_at",
			].join(" "),
		)
		.bind(canonicalModel, canonicalModel, importRegex, timestamp, timestamp)
		.run();
	await db
		.prepare(
			[
				"INSERT INTO model_aliases",
				"(alias, provider_hint, canonical_model, created_at, updated_at)",
				"VALUES (?, '', ?, ?, ?)",
				"ON CONFLICT(alias, provider_hint) DO UPDATE SET",
				"canonical_model = excluded.canonical_model,",
				"updated_at = excluded.updated_at",
			].join(" "),
		)
		.bind(canonicalModel, canonicalModel, timestamp, timestamp)
		.run();
}

async function updateCanonicalModelReferences(
	db: AppEnv["Bindings"]["DB"],
	previousCanonicalModel: string,
	nextCanonicalModel: string,
	importRegex: string | null,
) {
	const timestamp = nowIso();
	const tables = [
		"usage_logs",
		"attempt_events",
		"model_prices",
		"channel_model_capabilities",
	];
	for (const table of tables) {
		await db
			.prepare(
				`UPDATE ${table} SET canonical_model = ? WHERE canonical_model = ?`,
			)
			.bind(nextCanonicalModel, previousCanonicalModel)
			.run();
	}
	await db
		.prepare(
			[
				"UPDATE model_registry",
				"SET canonical_model = ?, display_name = ?, import_regex = ?, updated_at = ?",
				"WHERE canonical_model = ?",
			].join(" "),
		)
		.bind(
			nextCanonicalModel,
			nextCanonicalModel,
			importRegex,
			timestamp,
			previousCanonicalModel,
		)
		.run();
	await db
		.prepare(
			"UPDATE model_aliases SET canonical_model = ?, updated_at = ? WHERE canonical_model = ?",
		)
		.bind(nextCanonicalModel, timestamp, previousCanonicalModel)
		.run();
}

canonicalModels.get("/", async (c) => {
	const items = await listCanonicalModelItems(c.env.DB);
	return c.json({ items });
});

canonicalModels.get("/orphans/preview", async (c) => {
	const items = await listCanonicalModelCleanupItems(c.env.DB);
	return c.json({
		total: items.length,
		items,
	});
});

canonicalModels.post("/orphans/cleanup", async (c) => {
	const items = await listCanonicalModelCleanupItems(c.env.DB);
	for (const item of items) {
		await c.env.DB.prepare(
			"DELETE FROM model_aliases WHERE canonical_model = ?",
		)
			.bind(item.canonical_model)
			.run();
		await c.env.DB.prepare(
			"DELETE FROM model_registry WHERE canonical_model = ?",
		)
			.bind(item.canonical_model)
			.run();
	}
	if (items.length > 0) {
		await triggerBackupAfterDataChange(c.env.DB);
	}
	return c.json({
		ok: true,
		deleted: items.length,
		items,
	});
});

canonicalModels.delete("/orphans/:canonicalModel", async (c) => {
	const canonicalModel = normalizeText(c.req.param("canonicalModel"));
	if (!canonicalModel) {
		return jsonError(
			c,
			400,
			"canonical_model_required",
			"canonical_model_required",
		);
	}
	const target = (await listCanonicalModelCleanupItems(c.env.DB)).find(
		(item) => item.canonical_model === canonicalModel,
	);
	if (!target) {
		return jsonError(
			c,
			404,
			"cleanup_target_not_found",
			"cleanup_target_not_found",
		);
	}
	await c.env.DB.prepare("DELETE FROM model_aliases WHERE canonical_model = ?")
		.bind(target.canonical_model)
		.run();
	await c.env.DB.prepare("DELETE FROM model_registry WHERE canonical_model = ?")
		.bind(target.canonical_model)
		.run();
	await triggerBackupAfterDataChange(c.env.DB);
	return c.json({
		ok: true,
		item: target,
	});
});

canonicalModels.post("/sync", async (c) => {
	const result = await syncCanonicalModelAliases(c.env.DB);
	await triggerBackupAfterDataChange(c.env.DB);
	return c.json(result);
});

canonicalModels.post("/", async (c) => {
	const body = await c.req.json().catch(() => null);
	const canonicalModel = normalizeText(body?.canonical_model);
	if (!canonicalModel) {
		return jsonError(
			c,
			400,
			"canonical_model_required",
			"canonical_model_required",
		);
	}
	const importRegex = normalizePattern(body?.import_regex);
	if (importRegex) {
		try {
			new RegExp(importRegex, "i");
		} catch {
			return jsonError(c, 400, "invalid_regex", "invalid_regex");
		}
	}
	const existing = await c.env.DB.prepare(
		"SELECT canonical_model FROM model_registry WHERE canonical_model = ?",
	)
		.bind(canonicalModel)
		.first<{ canonical_model: string | null }>();
	if (existing?.canonical_model) {
		return jsonError(
			c,
			409,
			"canonical_model_exists",
			"canonical_model_exists",
		);
	}
	await ensureCanonicalModelBaseRows(c.env.DB, canonicalModel, importRegex);
	const aliases = parseAliases(body?.aliases, canonicalModel);
	for (const alias of aliases) {
		await c.env.DB.prepare(
			[
				"INSERT INTO model_aliases",
				"(alias, provider_hint, canonical_model, created_at, updated_at)",
				"VALUES (?, '', ?, ?, ?)",
				"ON CONFLICT(alias, provider_hint) DO UPDATE SET",
				"canonical_model = excluded.canonical_model,",
				"updated_at = excluded.updated_at",
			].join(" "),
		)
			.bind(alias, canonicalModel, nowIso(), nowIso())
			.run();
	}
	await triggerBackupAfterDataChange(c.env.DB);
	return c.json({ ok: true });
});

canonicalModels.patch("/:canonicalModel", async (c) => {
	const previousCanonicalModel = normalizeText(c.req.param("canonicalModel"));
	const body = await c.req.json().catch(() => null);
	if (!previousCanonicalModel) {
		return jsonError(
			c,
			400,
			"canonical_model_required",
			"canonical_model_required",
		);
	}
	if (!body) {
		return jsonError(c, 400, "missing_body", "missing_body");
	}
	const current = await c.env.DB.prepare(
		[
			"SELECT canonical_model, display_name, provider_hint, import_regex, created_at, updated_at",
			"FROM model_registry WHERE canonical_model = ?",
		].join(" "),
	)
		.bind(previousCanonicalModel)
		.first<CanonicalModelRow>();
	if (!current) {
		return jsonError(
			c,
			404,
			"canonical_model_not_found",
			"canonical_model_not_found",
		);
	}
	const nextCanonicalModel =
		normalizeText(body.canonical_model) || previousCanonicalModel;
	const importRegex = normalizePattern(body.import_regex);
	if (importRegex) {
		try {
			new RegExp(importRegex, "i");
		} catch {
			return jsonError(c, 400, "invalid_regex", "invalid_regex");
		}
	}
	const aliases = parseAliases(body.aliases, nextCanonicalModel);
	if (nextCanonicalModel !== previousCanonicalModel) {
		const conflict = await c.env.DB.prepare(
			"SELECT canonical_model FROM model_registry WHERE canonical_model = ?",
		)
			.bind(nextCanonicalModel)
			.first<{ canonical_model: string | null }>();
		if (conflict?.canonical_model) {
			return jsonError(
				c,
				409,
				"canonical_model_exists",
				"canonical_model_exists",
			);
		}
		await updateCanonicalModelReferences(
			c.env.DB,
			previousCanonicalModel,
			nextCanonicalModel,
			importRegex,
		);
	} else {
		await c.env.DB.prepare(
			[
				"UPDATE model_registry",
				"SET display_name = ?, import_regex = ?, updated_at = ?",
				"WHERE canonical_model = ?",
			].join(" "),
		)
			.bind(nextCanonicalModel, importRegex, nowIso(), previousCanonicalModel)
			.run();
	}
	await c.env.DB.prepare("DELETE FROM model_aliases WHERE canonical_model = ?")
		.bind(nextCanonicalModel)
		.run();
	for (const alias of aliases) {
		await c.env.DB.prepare(
			[
				"INSERT INTO model_aliases",
				"(alias, provider_hint, canonical_model, created_at, updated_at)",
				"VALUES (?, '', ?, ?, ?)",
				"ON CONFLICT(alias, provider_hint) DO UPDATE SET",
				"canonical_model = excluded.canonical_model,",
				"updated_at = excluded.updated_at",
			].join(" "),
		)
			.bind(alias, nextCanonicalModel, nowIso(), nowIso())
			.run();
	}
	await triggerBackupAfterDataChange(c.env.DB);
	return c.json({ ok: true });
});

canonicalModels.delete("/:canonicalModel", async (c) => {
	const canonicalModel = normalizeText(c.req.param("canonicalModel"));
	if (!canonicalModel) {
		return jsonError(
			c,
			400,
			"canonical_model_required",
			"canonical_model_required",
		);
	}
	await c.env.DB.prepare("DELETE FROM model_aliases WHERE canonical_model = ?")
		.bind(canonicalModel)
		.run();
	await c.env.DB.prepare("DELETE FROM model_registry WHERE canonical_model = ?")
		.bind(canonicalModel)
		.run();
	await c.env.DB.prepare(
		"UPDATE model_prices SET canonical_model = NULL WHERE canonical_model = ?",
	)
		.bind(canonicalModel)
		.run();
	await c.env.DB.prepare(
		"UPDATE usage_logs SET canonical_model = NULL WHERE canonical_model = ?",
	)
		.bind(canonicalModel)
		.run();
	await c.env.DB.prepare(
		"UPDATE attempt_events SET canonical_model = NULL WHERE canonical_model = ?",
	)
		.bind(canonicalModel)
		.run();
	await c.env.DB.prepare(
		"UPDATE channel_model_capabilities SET canonical_model = NULL WHERE canonical_model = ?",
	)
		.bind(canonicalModel)
		.run();
	await triggerBackupAfterDataChange(c.env.DB);
	return c.json({ ok: true });
});

export default canonicalModels;
