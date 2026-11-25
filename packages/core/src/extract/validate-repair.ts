import { validateConfig } from "../config/load";
import type { LoadedConfig } from "../config/types";
import { prepareOptions, prepareRules } from "../rules/prepare";
import type { FormatRule, LintRule, RulePlugin, RuleSettings } from "../rules/types";
import { AquariusError, errorMessage, toRunError } from "../shared/errors";
import type { RunError } from "../shared/types";

import type { ExtractionVerdict } from "./schemas";

interface ValidationContext {
  config: LoadedConfig;
  plugins: Record<string, RulePlugin>;
  candidates: ReadonlyMap<string, LintRule | FormatRule>;
  signal?: AbortSignal;
}

interface VerdictValidation {
  findings: Map<string, AcceptedVerdict>;
  issues: Map<string, RunError>;
}

type AcceptedVerdict = ExtractionVerdict & { setting: RuleSettings[string] | null };

interface RepairOptions extends ValidationContext {
  verdicts: ExtractionVerdict[];
  repair: (issues: RunError[]) => Promise<ExtractionVerdict[]>;
}

export const validateAndRepairVerdicts = async ({
  verdicts,
  repair,
  ...context
}: RepairOptions): Promise<{
  rules: RuleSettings;
  findings: ExtractionVerdict[];
  warnings: RunError[];
}> => {
  const { findings, issues } = await validateVerdicts(context, verdicts);
  const warnings: RunError[] = [];

  for (const [id, issue] of issues) {
    if (context.candidates.has(id)) continue;
    warnings.push(issue);
    issues.delete(id);
  }

  if (issues.size > 0) {
    try {
      assertActive(context.signal);
      const response = await repair([...issues.values()]);
      const repaired = await validateVerdicts(
        context,
        response.filter(({ ruleId }) => issues.has(ruleId)),
      );

      for (const [id, issue] of issues) {
        const finding = repaired.findings.get(id);
        if (!finding) {
          warnings.push(
            repaired.issues.get(id) ?? {
              ...issue,
              message: `${issue.message} (no correction returned)`,
            },
          );
          continue;
        }

        findings.set(id, finding);
      }
    } catch (error) {
      assertActive(context.signal);
      if (error instanceof AquariusError && error.code === "AI_ABORTED") throw error;
      for (const issue of issues.values()) {
        warnings.push({
          ...issue,
          message: `${issue.message} (repair failed: ${errorMessage(error)})`,
        });
      }
    }
  }

  const orderedIds = new Set(verdicts.map(({ ruleId }) => ruleId));
  const orderedFindings = Array.from(orderedIds, (id) => findings.get(id)).filter(
    (finding) => finding !== undefined,
  );

  return { rules: selectedRules(orderedFindings), findings: orderedFindings, warnings };
};

const validateVerdicts = async (
  { config, plugins, candidates, signal }: ValidationContext,
  verdicts: ExtractionVerdict[],
): Promise<VerdictValidation> => {
  const findings = new Map<string, AcceptedVerdict>();
  const issues = new Map<string, RunError>();
  const seen = new Set<string>();

  assertActive(signal);
  for (const verdict of verdicts) {
    const { ruleId, setting } = verdict;
    if (seen.has(ruleId)) {
      issues.set(ruleId, invalidVerdict(ruleId, "Returned more than one verdict for this rule."));
      findings.delete(ruleId);
      continue;
    }
    seen.add(ruleId);

    const definition = candidates.get(ruleId);
    if (!definition) {
      issues.set(ruleId, invalidVerdict(ruleId, "Rule is absent from the candidate catalog."));
      continue;
    }

    if (verdict.status === "insufficient_evidence") {
      if (setting === null) findings.set(ruleId, { ...verdict, setting });
      else
        issues.set(
          ruleId,
          invalidVerdict(ruleId, "Insufficient evidence requires a null setting."),
        );
      continue;
    }

    try {
      const parsed = validateConfig(config.tool, { rules: { [ruleId]: setting } });
      const validatedSetting = parsed.rules![ruleId]!;
      if (Array.isArray(validatedSetting) && validatedSetting[0] === "off") {
        prepareOptions(definition, validatedSetting[1]);
      }
      findings.set(ruleId, { ...verdict, setting: validatedSetting });
    } catch (error) {
      const issue = toRunError(error, "RULE_SETTING_INVALID", [ruleId]);
      issues.set(ruleId, { ...issue, message: `${ruleId}: ${issue.message}` });
    }
  }

  const rules = selectedRules(findings.values());
  if (Object.keys(rules).length > 0) {
    const prepared = await prepareRules({ ...config, preset: [], rules }, plugins);
    for (const issue of prepared.errors) {
      if (issue.ruleIds.length === 0) throw new AquariusError(issue.code, issue.message);
      for (const id of issue.ruleIds) {
        issues.set(id, issue);
        findings.delete(id);
      }
    }
  }
  assertActive(signal);

  return { findings, issues };
};

const selectedRules = (findings: Iterable<AcceptedVerdict>): RuleSettings => {
  const entries: [string, RuleSettings[string]][] = [];
  for (const { ruleId, setting } of findings) {
    if (setting !== null) entries.push([ruleId, setting]);
  }
  return Object.fromEntries(entries);
};

const invalidVerdict = (id: string, message: string): RunError => ({
  code: "EXTRACTION_VERDICT_INVALID",
  ruleIds: [id],
  message: `${id}: ${message}`,
});

const assertActive = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new AquariusError("AI_ABORTED", "Config extraction was cancelled.");
};
