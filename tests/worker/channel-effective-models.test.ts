import { describe, expect, it } from "vitest";
import { removeModelFromModelsJson } from "../../apps/worker/src/services/channel-models";
import {
	parseManualModelConfig,
	resolveChannelModelStatus,
	resolveEffectiveModelIds,
	stageNewlyDiscoveredModels,
	updateManualModelStatus,
} from "../../apps/worker/src/services/channel-effective-models";

describe("channel effective models", () => {
	it("使用验证模型和手动补充模型，并排除人工禁用模型", () => {
		const models = resolveEffectiveModelIds({
			channel: {
				models_json: JSON.stringify([{ id: "listed-only" }]),
				metadata_json: JSON.stringify({
					manual_include_models: ["manual-a", "manual-b", "verified-b"],
					manual_exclude_models: ["verified-a", "manual-b"],
				}),
			},
			verifiedModels: new Set(["verified-a", "verified-b"]),
		});

		expect(models).toEqual(["verified-b", "manual-a"]);
	});

	it("没有验证模型和人工配置时使用旧 models_json 兜底", () => {
		const models = resolveEffectiveModelIds({
			channel: {
				models_json: JSON.stringify([{ id: "legacy-a" }, { id: "legacy-b" }]),
				metadata_json: null,
			},
			verifiedModels: new Set(),
		});

		expect(models).toEqual(["legacy-a", "legacy-b"]);
	});

	it("存在人工配置时不再把旧 models_json 自动视为可用模型", () => {
		const models = resolveEffectiveModelIds({
			channel: {
				models_json: JSON.stringify([{ id: "listed-only" }]),
				metadata_json: JSON.stringify({
					manual_include_models: ["manual-only"],
					manual_exclude_models: [],
				}),
			},
			verifiedModels: new Set(),
		});

		expect(models).toEqual(["manual-only"]);
	});

	it("解析逗号和换行分隔的人工模型配置", () => {
		const config = parseManualModelConfig(
			JSON.stringify({
				manual_include_models: "gpt-4.1,\nclaude-3-5-sonnet\n gpt-4.1 ",
				manual_pending_models: "new-model,\npreview-model",
				manual_exclude_models: ["bad-model", "", " bad-model "],
			}),
		);

		expect(config.include).toEqual(["gpt-4.1", "claude-3-5-sonnet"]);
		expect(config.pending).toEqual(["new-model", "preview-model"]);
		expect(config.exclude).toEqual(["bad-model"]);
	});

	it("待加入模型不会参与有效模型", () => {
		const models = resolveEffectiveModelIds({
			channel: {
				models_json: JSON.stringify([{ id: "legacy-only" }]),
				metadata_json: JSON.stringify({
					manual_include_models: ["manual-ready"],
					manual_pending_models: ["verified-pending", "manual-pending"],
					manual_exclude_models: ["verified-blocked"],
				}),
			},
			verifiedModels: new Set([
				"verified-ready",
				"verified-pending",
				"verified-blocked",
			]),
		});

		expect(models).toEqual(["verified-ready", "manual-ready"]);
	});

	it("可结构化切换模型状态", () => {
		const pendingMetadata = updateManualModelStatus(null, {
			model: "new-model",
			status: "pending",
		});
		expect(resolveChannelModelStatus(pendingMetadata, "new-model")).toBe(
			"pending",
		);

		const enabledMetadata = updateManualModelStatus(pendingMetadata, {
			model: "new-model",
			status: "enabled",
		});
		expect(parseManualModelConfig(enabledMetadata)).toEqual({
			include: ["new-model"],
			pending: [],
			exclude: [],
		});
		expect(resolveChannelModelStatus(enabledMetadata, "new-model")).toBe(
			"enabled",
		);

		const excludedMetadata = updateManualModelStatus(enabledMetadata, {
			model: "new-model",
			status: "excluded",
		});
		expect(parseManualModelConfig(excludedMetadata)).toEqual({
			include: [],
			pending: [],
			exclude: ["new-model"],
		});
		expect(resolveChannelModelStatus(excludedMetadata, "new-model")).toBe(
			"excluded",
		);

		const clearedMetadata = updateManualModelStatus(excludedMetadata, {
			model: "new-model",
			status: "auto",
		});
		expect(parseManualModelConfig(clearedMetadata)).toEqual({
			include: [],
			pending: [],
			exclude: [],
		});
		expect(resolveChannelModelStatus(clearedMetadata, "new-model")).toBe(
			"auto",
		);
	});

	it("刷新发现的新模型进入待加入且保留已有状态", () => {
		const metadata = stageNewlyDiscoveredModels(
			JSON.stringify({
				site_type: "new-api",
				manual_include_models: ["manual-ready"],
				manual_exclude_models: ["blocked-model"],
			}),
			["known-model"],
			["known-model", "manual-ready", "blocked-model", "brand-new-model"],
		);

		expect(parseManualModelConfig(metadata)).toEqual({
			include: ["manual-ready"],
			pending: ["brand-new-model"],
			exclude: ["blocked-model"],
		});
		expect(JSON.parse(metadata ?? "{}").site_type).toBe("new-api");
	});

	it("渠道首次拉取模型时全部进入正式", () => {
		const metadata = stageNewlyDiscoveredModels(
			JSON.stringify({
				site_type: "new-api",
			}),
			[],
			["alpha-model", "beta-model", "alpha-model"],
		);

		expect(parseManualModelConfig(metadata)).toEqual({
			include: ["alpha-model", "beta-model"],
			pending: [],
			exclude: [],
		});
		expect(JSON.parse(metadata ?? "{}").site_type).toBe("new-api");
	});

	it("刷新后会移除不再存在的正式模型，但保留排除模型", () => {
		const metadata = stageNewlyDiscoveredModels(
			JSON.stringify({
				site_type: "new-api",
				manual_include_models: ["stale-enabled", "still-enabled"],
				manual_pending_models: ["pending-model"],
				manual_exclude_models: ["blocked-model"],
			}),
			["stale-enabled", "still-enabled", "blocked-model"],
			["still-enabled", "brand-new-model"],
		);

		expect(parseManualModelConfig(metadata)).toEqual({
			include: ["still-enabled"],
			pending: ["pending-model", "brand-new-model"],
			exclude: ["blocked-model"],
		});
	});

	it("删除模型时从已发现模型列表中移除", () => {
		const modelsJson = removeModelFromModelsJson(
			JSON.stringify([{ id: "keep-a" }, { id: "remove-me" }, "keep-b"]),
			"remove-me",
		);

		expect(JSON.parse(modelsJson)).toEqual([
			{ id: "keep-a" },
			{ id: "keep-b" },
		]);
	});
});
