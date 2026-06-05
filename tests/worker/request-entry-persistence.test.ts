import { describe, expect, it } from "vitest";
import { persistAutomaticRequestEntryFormat } from "../../apps/worker/src/services/proxy/request-entry-persistence";

describe("request entry persistence", () => {
	it("自动模式成功后不再回写明确请求格式", async () => {
		const calls: Array<{ sql: string; bindings: unknown[] }> = [];
		const db = {
			prepare(sql: string) {
				return {
					bind(...bindings: unknown[]) {
						calls.push({ sql, bindings });
						return {
							async run() {
								return {};
							},
						};
					},
				};
			},
		};

		await persistAutomaticRequestEntryFormat({
			db: db as never,
			channel: {
				id: "ch_test",
				metadata_json: JSON.stringify({
					site_type: "openai",
					request_entry: {
						path: "/codex",
						format: null,
					},
					manual_include_models: ["manual"],
				}),
			},
			path: "/codex",
			format: "openai_responses",
		});

		expect(calls).toHaveLength(0);
	});

	it("默认端点成功后也不会回写明确请求格式", async () => {
		const calls: Array<{ sql: string; bindings: unknown[] }> = [];
		const db = {
			prepare(sql: string) {
				return {
					bind(...bindings: unknown[]) {
						calls.push({ sql, bindings });
						return {
							async run() {
								return {};
							},
						};
					},
				};
			},
		};

		await persistAutomaticRequestEntryFormat({
			db: db as never,
			channel: {
				id: "ch_test",
				metadata_json: JSON.stringify({
					site_type: "openai",
					request_entry: {
						path: null,
						format: null,
					},
				}),
			},
			format: "openai_responses",
		});

		expect(calls).toHaveLength(0);
	});
});
