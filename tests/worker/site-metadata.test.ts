import { describe, expect, it } from "vitest";
import {
	buildSiteMetadata,
	parseSiteMetadata,
} from "../../apps/worker/src/services/site-metadata";

describe("site metadata manual models", () => {
	it("解析人工补充和排除模型", () => {
		const metadata = parseSiteMetadata(
			JSON.stringify({
				site_type: "openai",
				manual_include_models: "manual-a,\nmanual-b",
				manual_exclude_models: ["bad-a", "bad-a", ""],
			}),
		);

		expect(metadata.manual_include_models).toEqual(["manual-a", "manual-b"]);
		expect(metadata.manual_exclude_models).toEqual(["bad-a"]);
	});

	it("更新站点类型时保留人工模型配置", () => {
		const updated = buildSiteMetadata(
			JSON.stringify({
				manual_include_models: ["manual-a"],
				manual_exclude_models: ["bad-a"],
			}),
			{ site_type: "gemini" },
		);
		const metadata = parseSiteMetadata(updated);

		expect(metadata.site_type).toBe("gemini");
		expect(metadata.manual_include_models).toEqual(["manual-a"]);
		expect(metadata.manual_exclude_models).toEqual(["bad-a"]);
	});

	it("可覆盖人工模型配置", () => {
		const updated = buildSiteMetadata(
			JSON.stringify({
				manual_include_models: ["old"],
				manual_exclude_models: ["bad-old"],
			}),
			{
				manual_include_models: ["new", "new"],
				manual_exclude_models: ["bad-new"],
			},
		);
		const metadata = parseSiteMetadata(updated);

		expect(metadata.manual_include_models).toEqual(["new"]);
		expect(metadata.manual_exclude_models).toEqual(["bad-new"]);
	});
});
