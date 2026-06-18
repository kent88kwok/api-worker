import { describe, expect, it } from "vitest";
import { removeModelFromModelsJson } from "../../../../apps/worker/src/domains/channel/models";
import {
	parseManualModelConfig,
	resolveChannelModelStatus,
	resolveEffectiveModelIds,
	stageNewlyDiscoveredModels,
	updateManualModelStatus,
} from "../../../../apps/worker/src/domains/channel/effective-models";

describe("channel effective models", () => {
	it("合并自动模型和手动补充模型，并排除人工禁用模型", () => {
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

		expect(models).toEqual(["verified-b", "listed-only", "manual-a"]);
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

	it("存在人工配置时仍把 models_json 视为自动模型来源", () => {
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

		expect(models).toEqual(["listed-only", "manual-only"]);
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
		expect(config.exclude).toEqual(["bad-model"]);
	});

	it("历史 pending 字段不再阻止自动模型参与路由", () => {
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

		expect(models).toEqual([
			"verified-ready",
			"verified-pending",
			"legacy-only",
			"manual-ready",
		]);
	});

	it("可结构化切换模型状态", () => {
		const manualMetadata = updateManualModelStatus(null, {
			model: "new-model",
			status: "manual",
		});
		expect(parseManualModelConfig(manualMetadata)).toEqual({
			include: ["new-model"],
			exclude: [],
		});
		expect(resolveChannelModelStatus(manualMetadata, "new-model")).toBe(
			"manual",
		);

		const excludedMetadata = updateManualModelStatus(manualMetadata, {
			model: "new-model",
			status: "excluded",
		});
		expect(parseManualModelConfig(excludedMetadata)).toEqual({
			include: [],
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
			exclude: [],
		});
		expect(resolveChannelModelStatus(clearedMetadata, "new-model")).toBe(
			"auto",
		);
	});

	it("刷新用最新自动快照清理手动命中模型并丢弃历史 pending 字段", () => {
		const metadata = stageNewlyDiscoveredModels(
			JSON.stringify({
				site_type: "new-api",
				manual_include_models: ["manual-ready", "manual-still"],
				manual_pending_models: ["legacy-pending"],
				manual_exclude_models: ["blocked-model"],
			}),
			["known-model"],
			["known-model", "manual-ready", "blocked-model", "brand-new-model"],
		);

		expect(parseManualModelConfig(metadata)).toEqual({
			include: ["manual-still"],
			exclude: ["blocked-model"],
		});
		expect(JSON.parse(metadata ?? "{}").site_type).toBe("new-api");
	});

	it("渠道首次拉取模型时模型保持自动来源而不是写入手动列表", () => {
		const metadata = stageNewlyDiscoveredModels(
			JSON.stringify({
				site_type: "new-api",
			}),
			[],
			["alpha-model", "beta-model", "alpha-model"],
		);

		expect(parseManualModelConfig(metadata)).toEqual({
			include: [],
			exclude: [],
		});
		expect(JSON.parse(metadata ?? "{}").site_type).toBe("new-api");
	});

	it("刷新后只保留未被拉取命中的手动模型和排除模型", () => {
		const metadata = stageNewlyDiscoveredModels(
			JSON.stringify({
				site_type: "new-api",
				manual_include_models: ["manual-fallback", "now-auto"],
				manual_pending_models: ["pending-model"],
				manual_exclude_models: ["blocked-model"],
			}),
			["old-auto", "now-auto", "blocked-model"],
			["now-auto", "brand-new-model"],
		);

		expect(parseManualModelConfig(metadata)).toEqual({
			include: ["manual-fallback"],
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
