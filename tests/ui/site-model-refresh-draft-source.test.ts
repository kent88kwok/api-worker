import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync("apps/ui/src/App.tsx", "utf8");
const channelsViewSource = readFileSync(
	"apps/ui/src/features/ChannelsView.tsx",
	"utf8",
);

describe("site model refresh draft source contracts", () => {
	it("编辑弹窗里的拉取模型会走当前草稿配置", () => {
		expect(channelsViewSource).toContain("onRefreshDraftSite(activeModelSite.id)");
		expect(channelsViewSource).not.toContain("onRefreshSite(activeModelSite)");
	});

	it("草稿拉取会调用站点预览刷新接口", () => {
		expect(appSource).toContain("/refresh-preview");
		expect(appSource).toContain("setSiteModelPreviewBySiteId");
	});
});
