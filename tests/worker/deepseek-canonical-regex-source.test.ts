import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planCanonicalModelSync } from "../../apps/worker/src/services/canonical-model-registry";

const migrationPath =
	"apps/worker/migrations/0028_refine_deepseek_version_regex.sql";

function readMigration() {
	return readFileSync(migrationPath, "utf8");
}

function extractUpdatedRegex(sql: string, canonicalModel: string) {
	const statements = sql.split(/;\s*/u);
	const statement =
		statements.find((item) =>
			item.includes(`WHERE canonical_model = '${canonicalModel}'`),
		) ??
		statements.find((item) =>
			item.includes(`'${canonicalModel}'`) &&
			item.includes("INSERT INTO model_registry"),
		);
	if (!statement) {
		throw new Error(`missing regex definition for ${canonicalModel}`);
	}
	const match =
		statement.match(/SET import_regex = '([^']+)'/u) ??
		statement.match(/NULL,\s*'([^']+)'/u);
	if (!match) {
		throw new Error(`missing regex definition for ${canonicalModel}`);
	}
	return match[1];
}

describe("deepseek canonical regex migration", () => {
	it("避免把具体小版本同时归到 deepseek-v3 大类", () => {
		const sql = readMigration();
		const result = planCanonicalModelSync({
			rules: [
				{
					canonical_model: "deepseek/deepseek-v3",
					import_regex: extractUpdatedRegex(sql, "deepseek/deepseek-v3"),
				},
				{
					canonical_model: "deepseek/deepseek-v3.1",
					import_regex: extractUpdatedRegex(sql, "deepseek/deepseek-v3.1"),
				},
				{
					canonical_model: "deepseek/deepseek-v3.2",
					import_regex: extractUpdatedRegex(sql, "deepseek/deepseek-v3.2"),
				},
			],
			candidates: [
				{
					alias: "deepseek-v3-1-terminus",
					hits: 1,
					last_seen_at: null,
					sources: ["channel_capability"],
				},
				{
					alias: "deepseek-v3-2-251201",
					hits: 1,
					last_seen_at: null,
					sources: ["channel_capability"],
				},
			],
			bindings: new Map(),
		});

		expect(result.conflicts).toEqual([]);
		expect(result.imported).toEqual([
			expect.objectContaining({
				alias: "deepseek-v3-1-terminus",
				canonical_model: "deepseek/deepseek-v3.1",
			}),
			expect.objectContaining({
				alias: "deepseek-v3-2-251201",
				canonical_model: "deepseek/deepseek-v3.2",
			}),
		]);
	});

	it("把 deepseek-chat / deepseek-reasoner 收紧为兼容别名，不再吞掉其他版本后缀", () => {
		const sql = readMigration();
		const chatRegex = new RegExp(
			extractUpdatedRegex(sql, "deepseek/deepseek-chat"),
			"i",
		);
		const reasonerRegex = new RegExp(
			extractUpdatedRegex(sql, "deepseek/deepseek-reasoner"),
			"i",
		);

		expect(chatRegex.test("deepseek-chat")).toBe(true);
		expect(chatRegex.test("deepseek-chat-v3.2")).toBe(false);
		expect(reasonerRegex.test("deepseek-reasoner")).toBe(true);
		expect(reasonerRegex.test("deepseek-reasoner-v4")).toBe(false);
	});

	it("把最新的 deepseek-v3.2-exp / deepseek-v3.2-speciale 作为独立小版本导入", () => {
		const sql = readMigration();
		const result = planCanonicalModelSync({
			rules: [
				{
					canonical_model: "deepseek/deepseek-v3.2",
					import_regex: extractUpdatedRegex(sql, "deepseek/deepseek-v3.2"),
				},
				{
					canonical_model: "deepseek/deepseek-v3.2-exp",
					import_regex: extractUpdatedRegex(
						sql,
						"deepseek/deepseek-v3.2-exp",
					),
				},
				{
					canonical_model: "deepseek/deepseek-v3.2-speciale",
					import_regex: extractUpdatedRegex(
						sql,
						"deepseek/deepseek-v3.2-speciale",
					),
				},
			],
			candidates: [
				{
					alias: "deepseek-v3.2-exp",
					hits: 1,
					last_seen_at: null,
					sources: ["channel_capability"],
				},
				{
					alias: "deepseek-v3.2-speciale",
					hits: 1,
					last_seen_at: null,
					sources: ["channel_capability"],
				},
			],
			bindings: new Map(),
		});

		expect(result.conflicts).toEqual([]);
		expect(result.imported).toEqual([
			expect.objectContaining({
				alias: "deepseek-v3.2-exp",
				canonical_model: "deepseek/deepseek-v3.2-exp",
			}),
			expect.objectContaining({
				alias: "deepseek-v3.2-speciale",
				canonical_model: "deepseek/deepseek-v3.2-speciale",
			}),
		]);
	});
});
