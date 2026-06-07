import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const usageObserveSource = readFileSync(
	"apps/worker/src/services/proxy/usage-observe.ts",
	"utf8",
);

describe("usage observe source contracts", () => {
	it("不会仅因成功响应里存在 error:null 字段就判为异常成功", () => {
		expect(usageObserveSource).toContain("hasMeaningfulErrorField");
		expect(usageObserveSource).not.toContain('if (!("error" in record)) {');
	});
});
