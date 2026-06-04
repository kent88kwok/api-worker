import { expect, test } from "@playwright/test";

test("settings 页面可保存验证最多尝试模型数且无控制台报错", async ({
	page,
}) => {
	let savedPayload: Record<string, unknown> | null = null;
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

	await page.route("**/api/settings", async (route, request) => {
		if (request.method() === "PUT") {
			savedPayload = request.postDataJSON() as Record<string, unknown>;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true }),
			});
			return;
		}

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

	await page.route("**/api/usage/error-codes?limit=500", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ items: [] }),
		});
	});

	await page.route("**/api/backup/sync-config", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				enabled: false,
				schedule_time: "04:20",
				sync_mode: "push",
				conflict_policy: "local_wins",
				import_mode: "merge",
				webdav_url: "",
				webdav_username: "",
				webdav_password: "",
				webdav_path: "api-worker-backup",
				keep_versions: 30,
				instance_id: "local",
				last_sync_at: null,
				last_sync_status: "idle",
				last_sync_message: null,
				pending_changes: false,
				pending_at: null,
				config_ready: false,
			}),
		});
	});

	await page.goto("/settings");

	const input = page.locator('input[name="site_verification_model_limit"]');
	await expect(input).toBeVisible();
	await expect(input).toHaveValue("3");

	await input.fill("5");
	await page.getByRole("button", { name: "保存设置" }).click();

	await expect
		.poll(() => savedPayload)
		.toMatchObject({ site_verification_model_limit: 5 });
	await expect(pageErrors, `页面异常: ${pageErrors.join("\n")}`).toEqual([]);
	await expect(
		consoleErrors,
		`控制台错误: ${consoleErrors.join("\n")}`,
	).toEqual([]);
});
