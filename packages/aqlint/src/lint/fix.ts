import { z } from "zod";
import {
  AquariusError,
  applyFileChanges,
  buildTaskPrompt,
  callBridge,
  collectErrors,
  errorSchema,
  planFileChanges,
  references,
} from "@aquarius/core/internal";
import type {
  AiBridge,
  FileBaseline,
  JsonObject,
  PathPolicy,
  RuleResources,
  RunError,
  LoadedConfig,
} from "@aquarius/core/internal";
import type { Diagnostic } from "./types";

const fixResponseSchema = z.strictObject({
  errors: z.array(errorSchema),
  changes: z.array(
    z.strictObject({
      path: z.string(),
      oldText: z.string().min(1),
      newText: z.string(),
      ruleIds: z.array(z.string()).min(1),
    }),
  ),
});

export const fixDiagnostics = async (
  diagnostics: Diagnostic[],
  ruleResources: RuleResources,
  policy: PathPolicy,
  config: LoadedConfig,
  bridge: AiBridge,
  baseline: ReadonlyMap<string, FileBaseline>,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<{ changedFiles: string[]; errors: RunError[] }> => {
  const diagnosedRules = new Set(diagnostics.flatMap(({ rules }) => rules.map(({ rule }) => rule)));
  const resources = {
    directory: ruleResources.directory,
    files: ruleResources.files.filter(({ ruleId }) => diagnosedRules.has(ruleId)),
  };
  const prompt = buildTaskPrompt(
    [
      "Fix the supplied lint diagnostics using the configured lint rules. Preserve intended behavior, public contracts, error handling, and unrelated code. Do not perform formatting-only changes or apply formatter rules.",
      "Propose exact text replacements in existing selected target files only. oldText must occur exactly once in the original file. Replacements in the same file must not overlap. Preserve line endings. Do not create, delete, or move files.",
      "Each replacement must cite the diagnosed rule IDs it fixes. If a safe correction cannot be inferred, leave that issue unchanged. Return an empty changes array if no safe corrections are available.",
      "Read the full detail file for every diagnosed rule before proposing its correction. Report unreadable or unavailable rule details in errors and return no changes. If no safe correction exists, return empty changes and empty errors. Do not return per-diagnostic processing statuses.",
    ],
    resources.files,
    policy,
    {
      task: "lint-fix",
      diagnostics: diagnostics as unknown as JsonObject[],
    },
  );
  const raw = await callBridge(
    bridge,
    {
      projectRoot: policy.projectRoot,
      readableFiles: policy.readableFiles,
      ignore: policy.ignoreRules,
      prompt,
      ruleResources: resources,
      outputSchema: z.toJSONSchema(fixResponseSchema) as JsonObject,
      options: config.ai.options,
      onProgress,
    },
    config.ai.timeoutMs,
    signal,
  );
  if (signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
  const parsed = fixResponseSchema.safeParse(raw);
  if (!parsed.success) throw new AquariusError("INVALID_FIX_RESPONSE", parsed.error.message);
  const errors: RunError[] = [];
  collectErrors(parsed.data.errors, diagnosedRules, errors);
  if (errors.length) {
    return { changedFiles: [], errors };
  }
  const targets = new Set(policy.targets);
  const changes = parsed.data.changes.map((change) => {
    references(change.ruleIds, diagnosedRules);
    if (!targets.has(change.path) || !policy.canWrite(change.path)) {
      throw new AquariusError(
        "CHANGE_OUTSIDE_SCOPE",
        `Fix is outside the selected targets: ${change.path}`,
      );
    }
    if (
      !change.ruleIds.every((id) =>
        diagnostics.some(
          (diagnostic) =>
            diagnostic.rules.some(({ rule }) => rule === id) &&
            diagnostic.locations.some(({ path }) => path === change.path),
        ),
      )
    ) {
      throw new AquariusError(
        "FIX_WITHOUT_DIAGNOSTIC",
        `Fix has no matching diagnostic in ${change.path}.`,
      );
    }
    return { ...change, op: "replace" as const };
  });
  const plan = await planFileChanges(
    config.projectRoot,
    changes,
    (path) => targets.has(path) && policy.canWrite(path),
    baseline,
  );
  if (signal?.aborted) throw new AquariusError("AI_ABORTED", "Execution was cancelled.");
  // Lint fixes use transactional recovery without replacing aqfmt's Git undo history.
  return { changedFiles: (await applyFileChanges(plan, null)).changedFiles, errors };
};
