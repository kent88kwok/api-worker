import { expect, test } from "@playwright/test";

test("统一模型页面可清理残留模型且无控制台报错", async ({ page }) => {
	let cleanupRequestCount = 0;
	let canonicalListRequestCount = 0;
	const orphanItems = [
		{
			canonical_model: "gpt-5",
			import_regex: null,
			created_at: "2026-06-05T00:00:00.000Z",
			updated_at: "2026-06-05T00:00:00.000Z",
			replacement_canonical_models: ["openai/gpt-5"],
		},
		{
			canonical_model: "gpt-5.1",
			import_regex: null,
			created_at: "2026-06-05T00:00:00.000Z",
			updated_at: "2026-06-05T00:00:00.000Z",
			replacement_canonical_models: ["openai/gpt-5.1"],
		},
		{
			canonical_model: "gpt-5.2",
			import_regex: null,
			created_at: "2026-06-05T00:00:00.000Z",
			updated_at: "2026-06-05T00:00:00.000Z",
			replacement_canonical_models: ["openai/gpt-5.2"],
		},
		{
			canonical_model: "gpt-5.3",
			import_regex: null,
			created_at: "2026-06-05T00:00:00.000Z",
			updated_at: "2026-06-05T00:00:00.000Z",
			replacement_canonical_models: ["openai/gpt-5.3"],
		},
		{
			canonical_model: "gpt-5.4",
			import_regex: null,
			created_at: "2026-06-05T00:00:00.000Z",
			updated_at: "2026-06-05T00:00:00.000Z",
			replacement_canonical_models: ["openai/gpt-5.4"],
		},
		{
			canonical_model: "gpt-5.5",
			import_regex: null,
			created_at: "2026-06-05T00:00:00.000Z",
			updated_at: "2026-06-05T00:00:00.000Z",
			replacement_canonical_models: ["openai/gpt-5.5"],
		},
		{
			canonical_model: "gpt-5.6",
			import_regex: null,
			created_at: "2026-06-05T00:00:00.000Z",
			updated_at: "2026-06-05T00:00:00.000Z",
			replacement_canonical_models: ["openai/gpt-5.6"],
		},
		{
			canonical_model: "gpt-5.7",
			import_regex: null,
			created_at: "2026-06-05T00:00:00.000Z",
			updated_at: "2026-06-05T00:00:00.000Z",
			replacement_canonical_models: ["openai/gpt-5.7"],
		},
		{
			canonical_model: "gpt-5.8",
			import_regex: null,
			created_at: "2026-06-05T00:00:00.000Z",
			updated_at: "2026-06-05T00:00:00.000Z",
			replacement_canonical_models: ["openai/gpt-5.8"],
		},
	];
	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];

	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => {
		pageErrors.push(error.message);
	});

	await page.addInitScript(() => {
		window.localStorage.setItem("admin_token", "e2e-token");
	});

	await page.route("**/api/canonical-models", async (route, request) => {
		if (request.method() !== "GET") {
			await route.fallback();
			return;
		}
		canonicalListRequestCount += 1;
		const items =
			cleanupRequestCount > 0 || canonicalListRequestCount > 1
				? []
				: [
						{
							canonical_model: "openai/gpt-5",
							import_regex: "^gpt-5$",
							aliases: [
								{
									alias: "gpt-5",
									provider_hint: "",
									canonical_model: "openai/gpt-5",
								},
							],
							created_at: "2026-06-05T00:00:00.000Z",
							updated_at: "2026-06-05T00:00:00.000Z",
						},
					];
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ items }),
		});
	});

	await page.route("**/api/canonical-models/orphans/preview", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				total: orphanItems.length,
				items: orphanItems,
			}),
		});
	});

	await page.route(
		"**/api/canonical-models/orphans/*",
		async (route, request) => {
			if (request.method() !== "DELETE") {
				await route.fallback();
				return;
			}
			expect(request.method()).toBe("DELETE");
			const canonicalModel = decodeURIComponent(
				request.url().split("/").at(-1) ?? "",
			);
			const index = orphanItems.findIndex(
				(item) => item.canonical_model === canonicalModel,
			);
			if (index >= 0) {
				orphanItems.splice(index, 1);
			}
			cleanupRequestCount += 1;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					item: { canonical_model: canonicalModel },
				}),
			});
		},
	);

	await page.route(
		"**/api/canonical-models/orphans/cleanup",
		async (route, request) => {
			expect(request.method()).toBe("POST");
			cleanupRequestCount += 1;
			const deleted = orphanItems.length;
			orphanItems.splice(0, orphanItems.length);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					deleted,
					total: deleted,
					items: [],
				}),
			});
		},
	);

	await page.goto("/canonical-models");

	await expect(
		page.getByRole("button", { name: "清理残留模型" }),
	).toBeVisible();
	await page.getByRole("button", { name: "清理残留模型" }).click();
	await expect(
		page.getByRole("heading", { name: "清理残留模型" }),
	).toBeVisible();
	await expect(page.locator("li").filter({ hasText: "gpt-5.8" })).toHaveCount(
		1,
	);
	await page.getByRole("button", { name: "单独清理" }).first().click();
	await expect.poll(() => cleanupRequestCount).toBe(1);
	await expect(
		page.getByText("当前共有 8 个可清理的残留统一模型"),
	).toBeVisible();
	await page.getByRole("button", { name: "全部清理" }).click();

	await expect.poll(() => cleanupRequestCount).toBe(2);
	await expect(pageErrors, `页面异常: ${pageErrors.join("\n")}`).toEqual([]);
	await expect(
		consoleErrors,
		`控制台错误: ${consoleErrors.join("\n")}`,
	).toEqual([]);
});

test("价格页面可清理手动价格且无控制台报错", async ({ page }) => {
	let cleanupRequestCount = 0;
	let pricingListRequestCount = 0;
	const orphanPrices = [
		{
			id: "manual-1",
			provider: "manual",
			canonical_model: null,
			model_pattern: "gpt-legacy-1",
			model_name: "gpt-legacy-1",
			updated_at: "2026-06-05T00:00:00.000Z",
		},
		{
			id: "manual-2",
			provider: "manual",
			canonical_model: null,
			model_pattern: "gpt-legacy-2",
			model_name: "gpt-legacy-2",
			updated_at: "2026-06-05T00:00:00.000Z",
		},
		{
			id: "manual-3",
			provider: "manual",
			canonical_model: null,
			model_pattern: "gpt-legacy-3",
			model_name: "gpt-legacy-3",
			updated_at: "2026-06-05T00:00:00.000Z",
		},
		{
			id: "manual-4",
			provider: "manual",
			canonical_model: null,
			model_pattern: "gpt-legacy-4",
			model_name: "gpt-legacy-4",
			updated_at: "2026-06-05T00:00:00.000Z",
		},
		{
			id: "manual-5",
			provider: "manual",
			canonical_model: null,
			model_pattern: "gpt-legacy-5",
			model_name: "gpt-legacy-5",
			updated_at: "2026-06-05T00:00:00.000Z",
		},
		{
			id: "manual-6",
			provider: "manual",
			canonical_model: null,
			model_pattern: "gpt-legacy-6",
			model_name: "gpt-legacy-6",
			updated_at: "2026-06-05T00:00:00.000Z",
		},
		{
			id: "manual-7",
			provider: "manual",
			canonical_model: null,
			model_pattern: "gpt-legacy-7",
			model_name: "gpt-legacy-7",
			updated_at: "2026-06-05T00:00:00.000Z",
		},
		{
			id: "manual-8",
			provider: "manual",
			canonical_model: null,
			model_pattern: "gpt-legacy-8",
			model_name: "gpt-legacy-8",
			updated_at: "2026-06-05T00:00:00.000Z",
		},
		{
			id: "manual-9",
			provider: "manual",
			canonical_model: null,
			model_pattern: "gpt-legacy-9",
			model_name: "gpt-legacy-9",
			updated_at: "2026-06-05T00:00:00.000Z",
		},
	];
	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];

	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => {
		pageErrors.push(error.message);
	});

	await page.addInitScript(() => {
		window.localStorage.setItem("admin_token", "e2e-token");
	});

	await page.route("**/api/settings", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				log_retention_days: 30,
				session_ttl_hours: 12,
				admin_password_set: true,
				checkin_schedule_time: "00:10",
				channel_refresh_enabled: false,
				channel_refresh_schedule_time: "02:40",
				channel_recovery_probe_enabled: false,
				channel_recovery_probe_schedule_time: "03:10",
				site_verification_model_limit: 3,
				runtime_settings: {
					upstream_timeout_ms: 180000,
					retry_max_retries: 5,
					retry_sleep_ms: 500,
					retry_sleep_error_codes: [],
					retry_return_error_codes: [],
					channel_disable_error_codes: [],
					channel_disable_error_threshold: 3,
					channel_disable_error_code_minutes: 1440,
					zero_completion_as_error_enabled: true,
					model_failure_cooldown_minutes: 720,
					model_failure_cooldown_threshold: 3,
					stream_usage_mode: "lite",
					stream_usage_max_parsers: 0,
					stream_usage_parse_timeout_ms: 0,
					responses_affinity_ttl_seconds: 86400,
					stream_options_capability_ttl_seconds: 604800,
					attempt_worker_fallback_enabled: true,
					attempt_worker_fallback_threshold: 3,
					large_request_offload_threshold_bytes: 32768,
					site_task_concurrency: 4,
					site_task_timeout_ms: 12000,
					site_task_fallback_enabled: true,
					verification_model_limit: 3,
				},
				runtime_config: {
					upstream_timeout_ms: 180000,
					retry_max_retries: 5,
					retry_sleep_ms: 500,
					retry_sleep_error_codes: [],
					retry_return_error_codes: [],
					channel_disable_error_codes: [],
					channel_disable_error_threshold: 3,
					channel_disable_error_code_minutes: 1440,
					zero_completion_as_error_enabled: true,
					model_failure_cooldown_minutes: 720,
					model_failure_cooldown_threshold: 3,
					stream_usage_mode: "lite",
					stream_usage_max_parsers: 0,
					stream_usage_parse_timeout_ms: 0,
					responses_affinity_ttl_seconds: 86400,
					stream_options_capability_ttl_seconds: 604800,
					attempt_worker_fallback_enabled: true,
					attempt_worker_fallback_threshold: 3,
					large_request_offload_threshold_bytes: 32768,
					site_task_concurrency: 4,
					site_task_timeout_ms: 12000,
					site_task_fallback_enabled: true,
					verification_model_limit: 3,
					attempt_worker_bound: false,
					attempt_worker_fallback_active: false,
					attempt_worker_transport: "none",
				},
				pricing_settings: {
					sync_enabled: false,
					sync_schedule_time: "04:40",
					sync_sources: ["openai"],
					default_markup: 1,
					currency: "USD",
					usd_cny_rate: 7.2,
					last_sync_result: null,
				},
			}),
		});
	});

	await page.route("**/api/pricing/models", async (route, request) => {
		if (request.method() !== "GET") {
			await route.fallback();
			return;
		}
		pricingListRequestCount += 1;
		const prices =
			cleanupRequestCount > 0 || pricingListRequestCount > 1
				? []
				: [
						{
							id: "manual-1",
							provider: "manual",
							canonical_model: null,
							model_pattern: "gpt-legacy-*",
							model_name: "gpt-legacy-*",
							currency: "USD",
							input_price_per_1m: 1,
							cache_read_price_per_1m: 0,
							cache_write_price_per_1m: 1,
							output_price_per_1m: 2,
							source: "manual",
							source_url: null,
							sync_status: null,
							enabled: 1,
							created_at: "2026-06-05T00:00:00.000Z",
							updated_at: "2026-06-05T00:00:00.000Z",
						},
					];
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ prices }),
		});
	});

	await page.route(
		"**/api/pricing/models/manual-orphans/preview",
		async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					total: orphanPrices.length,
					items: orphanPrices,
				}),
			});
		},
	);

	await page.route(
		"**/api/pricing/models/manual-orphans/*",
		async (route, request) => {
			if (request.method() !== "DELETE") {
				await route.fallback();
				return;
			}
			expect(request.method()).toBe("DELETE");
			const id = decodeURIComponent(request.url().split("/").at(-1) ?? "");
			const index = orphanPrices.findIndex((item) => item.id === id);
			if (index >= 0) {
				orphanPrices.splice(index, 1);
			}
			cleanupRequestCount += 1;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					item: { id },
				}),
			});
		},
	);

	await page.route(
		"**/api/pricing/models/manual-orphans/cleanup",
		async (route, request) => {
			expect(request.method()).toBe("POST");
			cleanupRequestCount += 1;
			const deleted = orphanPrices.length;
			orphanPrices.splice(0, orphanPrices.length);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					ok: true,
					deleted,
					total: deleted,
					items: [],
				}),
			});
		},
	);

	await page.goto("/pricing");

	await expect(
		page.getByRole("button", { name: "清理手动价格" }),
	).toBeVisible();
	await page.getByRole("button", { name: "清理手动价格" }).click();
	await expect(
		page.getByRole("heading", { name: "清理手动价格" }),
	).toBeVisible();
	await expect(page.getByText("manual/gpt-legacy-9")).toHaveCount(1);
	await page.getByRole("button", { name: "单独清理" }).first().click();
	await expect.poll(() => cleanupRequestCount).toBe(1);
	await expect(page.getByText("当前共有 8 条可清理的手动价格")).toBeVisible();
	await page.getByRole("button", { name: "全部清理" }).click();

	await expect.poll(() => cleanupRequestCount).toBe(2);
	await expect(pageErrors, `页面异常: ${pageErrors.join("\n")}`).toEqual([]);
	await expect(
		consoleErrors,
		`控制台错误: ${consoleErrors.join("\n")}`,
	).toEqual([]);
});
