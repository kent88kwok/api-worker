import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	buildRecoveryCleanupGroups,
	type RecoveryCleanupGroup,
} from "../../apps/ui/src/core/sites";
import type { SiteVerificationResult } from "../../apps/ui/src/core/types";

const channelsViewSource = readFileSync(
	"apps/ui/src/features/ChannelsView.tsx",
	"utf8",
);
const appSource = readFileSync("apps/ui/src/App.tsx", "utf8");

const baseResult = (
	patch: Partial<SiteVerificationResult>,
): SiteVerificationResult => ({
	site_id: "site-a",
	site_name: "站点 A",
	mode: "recovery",
	verdict: "not_recoverable",
	message: "站点当前仍未满足恢复条件。",
	suggested_action: "manual_review",
	stages: {
		connectivity: {
			status: "pass",
			code: "reachable",
			message: "站点可达，但服务验证返回错误。",
		},
		capability: {
			status: "warn",
			code: "model_discovery_failed",
			message: "未能通过模型发现接口获取结果，将回退到已配置模型继续验证。",
		},
		service: {
			status: "fail",
			code: "upstream_http_429",
			message: "真实服务验证失败，HTTP 429。",
		},
		recovery: {
			status: "fail",
			code: "upstream_http_429",
			message: "站点尚未通过服务验证，当前不能恢复。",
		},
	},
	selected_model: "gpt-4.1",
	request_entry_format: "openai_chat",
	tried_models: ["gpt-4.1"],
	tried_request_formats: ["openai_chat"],
	attempts: [
		{
			model: "gpt-4.1",
			request_model: "gpt-4.1",
			request_entry_format: "openai_chat",
			endpoint_type: "chat",
			provider: "openai",
			status: "failed",
			http_status: 429,
			detail_code: "upstream_http_429",
			detail_message: "insufficient_quota",
			latency_ms: 31,
		},
	],
	selected_token: { id: "ct_a", name: "调用令牌 A" },
	discovered_models: [],
	token_results: [],
	token_summary: null,
	trace: {
		latency_ms: 31,
		upstream_status: 429,
		detail_code: "upstream_http_429",
		detail_message: "HTTP 429 | insufficient_quota",
	},
	checked_at: "2026-06-10T00:00:00.000Z",
	...patch,
});

const groupSiteIds = (groups: RecoveryCleanupGroup[]) =>
	groups.map((group) => group.items.map((item) => item.site_id));

describe("disabled site cleanup grouping", () => {
	it("按实际失败签名动态分组，不依赖预设语义分类", () => {
		const quotaA = baseResult({
			site_id: "quota-a",
			site_name: "额度站点 A",
		});
		const network = baseResult({
			site_id: "network-a",
			site_name: "网络站点 A",
			stages: {
				...baseResult({}).stages,
				connectivity: {
					status: "fail",
					code: "network_error",
					message: "无法连接到站点，请检查地址、网络或 TLS 配置。",
				},
				service: {
					status: "fail",
					code: "network_error",
					message: "真实服务验证未能连接到上游。",
				},
				recovery: {
					status: "fail",
					code: "network_error",
					message: "站点尚未通过服务验证，当前不能恢复。",
				},
			},
			attempts: [
				{
					model: "gpt-4.1",
					request_model: "gpt-4.1",
					request_entry_format: "openai_chat",
					endpoint_type: "chat",
					provider: "openai",
					status: "failed",
					http_status: null,
					detail_code: "network_error",
					detail_message: "fetch failed",
					latency_ms: 101,
				},
			],
			trace: {
				latency_ms: 101,
				detail_code: "network_error",
				detail_message: "fetch failed",
			},
		});
		const quotaB = baseResult({
			site_id: "quota-b",
			site_name: "额度站点 B",
		});

		const groups = buildRecoveryCleanupGroups([quotaA, network, quotaB]);

		expect(groupSiteIds(groups)).toEqual([
			["quota-a", "quota-b"],
			["network-a"],
		]);
		expect(groups[0].title).toContain("服务验证");
		expect(groups[0].title).toContain("upstream_http_429");
		expect(groups[0].evidence).toEqual(
			expect.arrayContaining(["HTTP 429", "upstream_http_429"]),
		);
		expect(groups[0].detail).toBe("HTTP 429 | insufficient_quota");
		expect(groups[0].title).not.toContain("余额");
	});

	it("没有上游尝试记录时，使用结构化阶段代码作为分组签名", () => {
		const first = baseResult({
			site_id: "missing-token-a",
			site_name: "缺令牌 A",
			stages: {
				connectivity: {
					status: "fail",
					code: "missing_token",
					message: "未找到可用的调用令牌。",
				},
				capability: {
					status: "fail",
					code: "missing_token",
					message: "缺少调用令牌，无法选择验证模型。",
				},
				service: {
					status: "fail",
					code: "missing_token",
					message: "缺少调用令牌，无法执行真实服务验证。",
				},
				recovery: {
					status: "fail",
					code: "missing_token",
					message: "缺少调用令牌，不能评估恢复。",
				},
			},
			attempts: [],
			trace: {},
		});
		const second = baseResult({
			...first,
			site_id: "missing-token-b",
			site_name: "缺令牌 B",
		});

		const groups = buildRecoveryCleanupGroups([first, second]);

		expect(groups).toHaveLength(1);
		expect(groups[0].id).toContain("missing_token");
		expect(groups[0].title).toContain("missing_token");
		expect(groupSiteIds(groups)).toEqual([
			["missing-token-a", "missing-token-b"],
		]);
	});

	it("检查停用渠道结果提供分组清理入口", () => {
		expect(channelsViewSource).toContain("buildRecoveryCleanupGroups");
		expect(channelsViewSource).toContain("清理停用站点");
		expect(channelsViewSource).toContain("一键删除全部");
		expect(channelsViewSource).toContain("全部 ·");
		expect(channelsViewSource).toContain("当前分组");
		expect(channelsViewSource).toContain("删除当前分组");
		expect(channelsViewSource).toContain("overflow-x-auto");
		expect(channelsViewSource).toContain("shrink-0 whitespace-nowrap");
		expect(channelsViewSource).toContain("onCleanupDisabledAll");
		expect(appSource).toContain("requestCleanupDisabledAll");
		expect(appSource).toContain("site:cleanupDisabledAll");
	});
});
