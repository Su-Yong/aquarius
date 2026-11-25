import { randomUUID } from "node:crypto";

import { z } from "zod";

import { hashContent } from "../adapter/rule-resources";
import { prepareOptions } from "../rules/prepare";
import type { RuleResource } from "../adapter/types";
import type { FormatRule, LintRule } from "../rules/types";
import type { ToolKind } from "../shared/types";

export const buildExtractionCatalog = async (
  tool: ToolKind,
  candidates: ReadonlyMap<string, LintRule | FormatRule>,
): Promise<RuleResource[]> => {
  const directory = `.aquarius-rules-${randomUUID()}`;

  return Promise.all(
    [...candidates].map(async ([id, rule]) => {
      const applicability = await defaultApplicability(rule);
      const optionsSchema = rule.optionsSchema
        ? z.toJSONSchema(rule.optionsSchema, { unrepresentable: "any", io: "input" })
        : null;
      const content = `${JSON.stringify(
        {
          id,
          description: rule.description,
          scope: rule.scope,
          optionsSchema,
          ...(applicability !== undefined && { applicability }),
        },
        null,
        2,
      )}\n`;

      return {
        ruleId: id,
        scope: rule.scope,
        applicability: applicability ?? rule.description,
        detailsPath: `${directory}/${tool}-${hashContent(id)}.json`,
        content,
        contentHash: hashContent(content),
      };
    }),
  );
};

const defaultApplicability = async (rule: LintRule | FormatRule): Promise<string | undefined> => {
  try {
    const options = prepareOptions(rule, {});
    const { applicability } = await rule.buildPrompt({ options: Object.freeze(options) });
    if (typeof applicability === "string" && applicability.trim() !== "") return applicability;
  } catch {
    // A rule may require options before it can describe its applicability.
  }
  return undefined;
};
