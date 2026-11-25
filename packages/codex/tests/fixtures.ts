import { createHash } from "node:crypto";
import type { RuleResource } from "@aqtools/core/adapter";

export const ruleResource = (): RuleResource => {
  const ruleId = "fixture/check";
  const applicability = "Files declaring a value.";
  const content = JSON.stringify({ ruleId, scope: "file", instructions: { applicability } });
  const contentHash = createHash("sha256").update(content).digest("hex");
  return {
    ruleId,
    scope: "file",
    applicability,
    detailsPath: `.aquarius-rules-fixture/lint-${contentHash}.json`,
    content,
    contentHash,
  };
};
