import type { PathPolicy } from "../files/types";
import type { PreparedRule } from "../rules/types";
import { AquariusError, toRunError } from "../shared/errors";
import type { RunError } from "../shared/types";
import { hasFailedReview, nonempty, normalizedPath } from "./results";
import type {
  Analysis,
  AnalysisOptions,
  AnalysisSnapshot,
  FileReview,
  ReviewResponse,
  ReviewUpdate,
  RuleReview,
} from "./types";

interface AnalysisHooks<Details, Update extends ReviewUpdate, Response extends ReviewResponse> {
  parse: (raw: unknown) => Update | undefined;
  initial: Details;
  apply: (
    update: Update,
    current: Readonly<Details>,
    files: ReadonlyMap<string, FileReview>,
    rules: ReadonlyMap<string, RuleReview>,
  ) => Details | Promise<Details>;
  final: (response: Response) => Details;
  retainIncomplete?: boolean;
}

export const notify = <Value>(
  observer: ((value: Value) => void) | undefined,
  value: Value,
  onFailure?: () => void,
): void => {
  try {
    Promise.resolve(observer?.(value)).catch(() => onFailure?.());
  } catch {
    onFailure?.();
  }
};

export const pendingFileReview = (path: string): FileReview => ({
  path,
  status: "pending",
  reason: "",
});

const pendingRuleReview = (ruleId: string): RuleReview => ({
  ruleId,
  status: "pending",
  reason: "",
});

export const finalRuleReviews = (
  rules: readonly PreparedRule[],
  response: ReviewResponse,
): RuleReview[] => {
  const skipped = new Map(response.skippedRules.map(({ ruleId, reason }) => [ruleId, reason]));
  const fileFailure = response.fileResults.find(({ status }) => status === "failed");
  return rules.map(({ id }): RuleReview => {
    const error = response.errors.find(
      ({ ruleIds }) => ruleIds.length === 0 || ruleIds.includes(id),
    );
    if (error) return { ruleId: id, status: "failed", reason: error.message };
    const reason = skipped.get(id);
    if (reason !== undefined) return { ruleId: id, status: "skipped", reason };
    if (fileFailure && response.errors.length === 0) {
      return { ruleId: id, status: "failed", reason: fileFailure.reason };
    }
    return { ruleId: id, status: "completed", reason: "" };
  });
};

const patchReviews = <Review extends FileReview | RuleReview>(
  reviews: ReadonlyMap<string, Review>,
  updates: readonly Review[],
  identify: (review: Review) => string,
  validate: (key: string) => void,
  label: string,
): Map<string, Review> => {
  const next = new Map(reviews);
  const seen = new Set<string>();
  for (const review of updates) {
    const key = identify(review);
    if (seen.has(key)) {
      throw new AquariusError(
        "DUPLICATE_ANALYSIS_ITEM",
        `A provisional update repeats a ${label}.`,
      );
    }
    seen.add(key);
    validate(key);
    if (review.status === "skipped" || review.status === "failed") {
      nonempty(review.reason, "Review reason");
    }
    next.set(key, review);
  }
  return next;
};

export const createAnalysisState = <
  Details extends object,
  Update extends ReviewUpdate,
  Response extends ReviewResponse,
>(
  rules: readonly PreparedRule[],
  policy: PathPolicy,
  hooks: AnalysisHooks<Details, Update, Response>,
  options: AnalysisOptions<Details> = {},
): Analysis<Details, Response> => {
  let files = new Map(policy.targets.map((path) => [path, pendingFileReview(path)]));
  let rulesById = new Map(rules.map(({ id }) => [id, pendingRuleReview(id)]));
  let details = hooks.initial;
  let revision = 0;
  let accepting = true;
  let pending = Promise.resolve();
  let latest: AnalysisSnapshot & Details;

  const warn = (message: string): void => notify(options.onWarning, message);
  const publish = (snapshot: AnalysisSnapshot & Details): AnalysisSnapshot & Details => {
    latest = structuredClone(snapshot);
    notify(options.onUpdate, structuredClone(latest), () =>
      warn("The provisional analysis observer failed; analysis will continue."),
    );
    return structuredClone(latest);
  };

  const provisional = (): AnalysisSnapshot & Details => ({
    ...details,
    phase: "provisional",
    revision,
    fileResults: [...files.values()],
    ruleResults: [...rulesById.values()],
    errors: [],
  });

  const update = (raw: unknown): void => {
    if (!accepting) return;
    const parsed = hooks.parse(raw);
    if (!parsed) {
      warn("Ignored an invalid provisional analysis update (INVALID_ANALYSIS_UPDATE).");
      return;
    }
    pending = pending.then(async () => {
      if (parsed.revision <= revision) return;
      try {
        const nextFiles = patchReviews(
          files,
          parsed.fileResults,
          ({ path }) => path,
          (path) => {
            normalizedPath(path);
            if (!files.has(path)) {
              throw new AquariusError(
                "INVALID_RESULT_PATH",
                "A provisional file status is outside the selected targets.",
              );
            }
          },
          "file path",
        );
        const nextRules = patchReviews(
          rulesById,
          parsed.ruleResults,
          ({ ruleId }) => ruleId,
          (id) => {
            if (!rulesById.has(id)) {
              throw new AquariusError(
                "INVALID_RULE_REFERENCE",
                "A provisional review references an unrequested rule.",
              );
            }
          },
          "rule ID",
        );
        details = await hooks.apply(parsed, details, nextFiles, nextRules);
        files = nextFiles;
        rulesById = nextRules;
        revision = parsed.revision;
        publish(provisional());
      } catch (cause) {
        const error = toRunError(cause, "INVALID_ANALYSIS_UPDATE");
        warn(`Ignored a provisional analysis update (${error.code}): ${error.message}`);
      }
    });
  };

  const close = (
    snapshot: () => AnalysisSnapshot & Details,
  ): Promise<AnalysisSnapshot & Details> => {
    accepting = false;
    const closed = pending.then(() => {
      revision += 1;
      return publish({ ...snapshot(), revision });
    });
    pending = closed.then(() => {});
    return closed;
  };

  const interrupt = (errors: readonly RunError[] = []) =>
    close(() => ({ ...latest, phase: "incomplete", errors: [...errors] }));

  const finish = (response: Response) => {
    const failed = hasFailedReview(response);
    if (failed && hooks.retainIncomplete) return interrupt(response.errors);
    return close(() => ({
      ...hooks.final(response),
      phase: failed ? "incomplete" : "final",
      revision,
      fileResults: response.fileResults,
      ruleResults: finalRuleReviews(rules, response),
      errors: response.errors,
    }));
  };

  publish(provisional());
  return { update, flush: () => pending, finish, interrupt };
};
