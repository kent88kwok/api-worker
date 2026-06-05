import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import canonicalModels from "./canonical-models";

type MockRow = Record<string, unknown>;

function createMockDb(data: { registry: MockRow[]; aliases: MockRow[] }) {
	return {
		prepare(sql: string) {
			return {
				all: async <T>() => {
					if (sql.includes("FROM model_registry")) {
						return { results: data.registry as T[] };
					}
					if (sql.includes("FROM model_aliases")) {
						return { results: data.aliases as T[] };
					}
					throw new Error(`Unexpected SQL: ${sql}`);
				},
			};
		},
	};
}

describe("canonical models route", () => {
	it("列表会隐藏没有精确别名且已被其他统一模型接管的残留项", async () => {
		const app = new Hono<{
			Bindings: {
				DB: ReturnType<typeof createMockDb>;
			};
		}>();
		app.route("/", canonicalModels);

		const response = await app.request(
			"http://localhost/",
			{},
			{
				DB: createMockDb({
					registry: [
						{
							canonical_model: "openai/gpt-5.4",
							display_name: "openai/gpt-5.4",
							provider_hint: null,
							import_regex: "^gpt-5\\.4$",
							created_at: "2026-06-05T00:00:00.000Z",
							updated_at: "2026-06-05T00:00:00.000Z",
						},
						{
							canonical_model: "gpt-5.4",
							display_name: "gpt-5.4",
							provider_hint: null,
							import_regex: null,
							created_at: "2026-06-05T00:00:00.000Z",
							updated_at: "2026-06-05T00:00:00.000Z",
						},
					],
					aliases: [
						{
							alias: "gpt-5.4",
							provider_hint: "",
							canonical_model: "openai/gpt-5.4",
						},
						{
							alias: "openai/gpt-5.4",
							provider_hint: "",
							canonical_model: "openai/gpt-5.4",
						},
					],
				}),
			},
		);
		const payload = (await response.json()) as {
			items: Array<{ canonical_model: string }>;
		};

		expect(payload.items).toEqual([
			expect.objectContaining({
				canonical_model: "openai/gpt-5.4",
			}),
		]);
	});
});
