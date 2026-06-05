import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const canonicalModelsViewSource = readFileSync(
	"apps/ui/src/features/CanonicalModelsView.tsx",
	"utf8",
);

describe("canonical models view source contracts", () => {
	it("冲突列表提供合并入口", () => {
		expect(canonicalModelsViewSource).toContain("合并到...");
		expect(canonicalModelsViewSource).toContain("合并冲突别名");
		expect(canonicalModelsViewSource).toContain("submitMerge");
		expect(canonicalModelsViewSource).toContain("merge-target-canonical-model");
		expect(canonicalModelsViewSource).toContain("一键合并可判定冲突");
		expect(canonicalModelsViewSource).toContain("handleMergeAllResolvableConflicts");
		expect(canonicalModelsViewSource).toContain(
			"resolveAutomaticConflictTarget",
		);
		expect(canonicalModelsViewSource).toContain("resolveManualConflictTarget");
		expect(canonicalModelsViewSource).toContain("可自动合并");
	});

	it("同步结果区使用限高滚动容器", () => {
		expect(
			canonicalModelsViewSource.match(/max-h-96 flex-col overflow-hidden/g)
				?.length ?? 0,
		).toBeGreaterThanOrEqual(2);
		expect(canonicalModelsViewSource).toContain("max-h-72 flex-col overflow-hidden");
		expect(canonicalModelsViewSource).toContain("flex-1 overflow-auto");
	});

	it("提供清理残留模型入口", () => {
		expect(canonicalModelsViewSource).toContain("清理残留模型");
		expect(canonicalModelsViewSource).toContain("onCleanupResidualModels");
	});
});
