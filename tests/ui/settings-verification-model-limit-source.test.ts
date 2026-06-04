import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsViewSource = readFileSync(
	"apps/ui/src/features/SettingsView.tsx",
	"utf8",
);
const appSource = readFileSync("apps/ui/src/App.tsx", "utf8");

describe("settings verification model limit source", () => {
	it("在设置页展示验证最多尝试模型数输入项", () => {
		expect(settingsViewSource).toContain("验证最多尝试模型数");
		expect(settingsViewSource).toContain('name="site_verification_model_limit"');
		expect(settingsViewSource).toContain(
			"自动请求格式会在同一模型下继续尝试",
		);
	});

	it("保存设置时会提交 site_verification_model_limit", () => {
		expect(appSource).toContain(
			"const siteVerificationModelLimit = Number(",
		);
		expect(appSource).toContain(
			"site_verification_model_limit: siteVerificationModelLimit",
		);
	});
});
