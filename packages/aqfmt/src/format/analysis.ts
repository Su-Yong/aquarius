import { AquariusError, nonempty, normalizedPath, toRunError } from "@aquarius/core/internal";
import type { PathPolicy, PreparedRule, RuleResources, RunError } from "@aquarius/core/internal";
import { createFormatValidator, formatChangePaths } from "./results";
import { formatAnalysisUpdateSchema } from "./schemas";
import type { FormatAnalysisUpdate } from "./schemas";
import type {
  FormatAnalysis,
  FormatAnalysisSnapshot,
  FormatFileReview,
  FormatResponse,
  FormatRuleReview,
} from "./types";

interface AnalysisOptions {
  onUpdate?: (snapshot: FormatAnalysisSnapshot) => void;
  onWarning?: (message: string) => void;
}

const assertUnique = (identifiers: readonly string[], label: string): void => {
  if (new Set(identifiers).size !== identifiers.length) {
    throw new AquariusError("DUPLICATE_ANALYSIS_ITEM", `A provisional update repeats a ${label}.`);
  }
};

export const createFormatAnalysis = (
  rules: readonly PreparedRule[],
  policy: PathPolicy,
  ruleResources: RuleResources,
  options: AnalysisOptions = {},
): FormatAnalysis => {
  const knownRules = new Set(rules.map(({ id }) => id));
  const targets = new Set(policy.targets);
  const validator = createFormatValidator(rules, policy, ruleResources);
  let fileResults = new Map<string, FormatFileReview>(
    policy.targets.map((path) => [path, { path, status: "pending", reason: "" }]),
  );
  let ruleResults = new Map<string, FormatRuleReview>(
    rules.map(({ id }) => [id, { ruleId: id, status: "pending", reason: "" }]),
  );
  let revision = 0;
  let accepting = true;
  let pending = Promise.resolve();
  let latest: FormatAnalysisSnapshot = {
    phase: "provisional",
    revision,
    fileResults: [...fileResults.values()],
    ruleResults: [...ruleResults.values()],
    proposedFiles: [],
    warnings: [],
    errors: [],
  };

  const warn = (message: string): void => {
    try {
      Promise.resolve(options.onWarning?.(message)).catch(() => {});
    } catch {
      // Reporting callbacks must not replace the analysis result or its original error.
    }
  };

  const publish = (snapshot: FormatAnalysisSnapshot): FormatAnalysisSnapshot => {
    latest = structuredClone(snapshot);
    try {
      Promise.resolve(options.onUpdate?.(structuredClone(latest))).catch(() => {
        warn("The provisional formatting observer failed; formatting will continue.");
      });
    } catch {
      warn("The provisional formatting observer failed; formatting will continue.");
    }
    return structuredClone(latest);
  };

  const apply = (update: FormatAnalysisUpdate): void => {
    if (update.revision <= revision) {
      return;
    }

    assertUnique(
      update.fileResults.map(({ path }) => path),
      "file path",
    );
    assertUnique(
      update.ruleResults.map(({ ruleId }) => ruleId),
      "rule ID",
    );
    assertUnique(update.proposedFiles, "proposed file path");

    const nextFiles = new Map(fileResults);
    const nextRules = new Map(ruleResults);
    const proposedFiles = update.proposedFiles.map((path) => validator.proposedPath(path));
    const warnings = update.warnings.map((warning) => validator.warning(warning));

    for (const file of update.fileResults) {
      normalizedPath(file.path);
      if (!targets.has(file.path)) {
        throw new AquariusError(
          "INVALID_RESULT_PATH",
          "A provisional file status is outside the selected targets.",
        );
      }
      if (file.status === "skipped" || file.status === "failed") {
        nonempty(file.reason, "File review reason");
      }
      nextFiles.set(file.path, file);
    }
    for (const rule of update.ruleResults) {
      if (!knownRules.has(rule.ruleId)) {
        throw new AquariusError(
          "INVALID_RULE_REFERENCE",
          "A provisional review references an unrequested rule.",
        );
      }
      if (rule.status === "skipped" || rule.status === "failed") {
        nonempty(rule.reason, "Rule review reason");
      }
      nextRules.set(rule.ruleId, rule);
    }

    for (const path of proposedFiles) {
      if (nextFiles.get(path)?.status === "skipped") {
        throw new AquariusError(
          "CONFLICTING_FILE_RESULT",
          "A provisionally skipped file also has a proposed change.",
        );
      }
    }
    if (
      proposedFiles.length > 0 &&
      [...nextRules.values()].every((rule) => rule.status === "skipped")
    ) {
      throw new AquariusError(
        "CONFLICTING_RULE_RESULT",
        "A proposed change remains after every requested rule was skipped.",
      );
    }
    for (const warning of warnings) {
      if (warning.ruleIds.some((id) => nextRules.get(id)?.status === "skipped")) {
        throw new AquariusError(
          "CONFLICTING_RULE_RESULT",
          "A provisionally skipped rule also has a warning.",
        );
      }
    }

    fileResults = nextFiles;
    ruleResults = nextRules;
    revision = update.revision;
    publish({
      phase: "provisional",
      revision,
      fileResults: [...fileResults.values()],
      ruleResults: [...ruleResults.values()],
      proposedFiles,
      warnings,
      errors: [],
    });
  };

  const update = (raw: unknown): void => {
    if (!accepting) {
      return;
    }
    const parsed = formatAnalysisUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      warn("Ignored an invalid provisional formatting update (INVALID_ANALYSIS_UPDATE).");
      return;
    }
    pending = pending.then(() => {
      try {
        apply(parsed.data);
      } catch (cause) {
        const error = toRunError(cause, "INVALID_ANALYSIS_UPDATE");
        warn(`Ignored a provisional formatting update (${error.code}): ${error.message}`);
      }
    });
  };

  const finish = (response: FormatResponse): Promise<FormatAnalysisSnapshot> => {
    accepting = false;
    const finished = pending.then(() => {
      const skipped = new Map(response.skippedRules.map((rule) => [rule.ruleId, rule.reason]));
      const failedFiles = response.fileResults.some((file) => file.status === "failed");
      const incomplete = response.errors.length > 0 || failedFiles;
      const finalRules = rules.map(({ id }): FormatRuleReview => {
        const error = response.errors.find(
          (entry) => entry.ruleIds.length === 0 || entry.ruleIds.includes(id),
        );
        if (error) {
          return { ruleId: id, status: "failed", reason: error.message };
        }
        const skippedReason = skipped.get(id);
        if (skippedReason !== undefined) {
          return { ruleId: id, status: "skipped", reason: skippedReason };
        }
        if (failedFiles && response.errors.length === 0) {
          return { ruleId: id, status: "failed", reason: "File review did not complete." };
        }
        return { ruleId: id, status: "completed", reason: "" };
      });

      revision += 1;
      return publish({
        phase: incomplete ? "incomplete" : "final",
        revision,
        fileResults: response.fileResults,
        ruleResults: finalRules,
        proposedFiles: formatChangePaths(response.changes),
        warnings: response.warnings,
        errors: response.errors,
      });
    });
    pending = finished.then(() => {});
    return finished;
  };

  const interrupt = (errors: readonly RunError[] = []): Promise<FormatAnalysisSnapshot> => {
    accepting = false;
    const interrupted = pending.then(() => {
      revision += 1;
      return publish({
        ...latest,
        phase: "incomplete",
        revision,
        errors: [...errors],
      });
    });
    pending = interrupted.then(() => {});
    return interrupted;
  };

  publish(latest);
  return { update, flush: () => pending, finish, interrupt };
};
