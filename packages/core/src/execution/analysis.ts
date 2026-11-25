import type { z } from "zod";

import { AquariusError, toRunError } from "../shared/errors";
import { formatZodIssues } from "../shared/zod";
import type { PathPolicy } from "../files/types";
import type { PreparedRule } from "../rules/types";
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
  schema: z.ZodType<Update>;
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
  let pending = Promise.resolve();

  const warn = (message: string): void => notify(options.onWarning, message);
  let latest: AnalysisSnapshot & Details;
  const publish = (snapshot: AnalysisSnapshot & Details): AnalysisSnapshot & Details => {
    latest = structuredClone(snapshot);
    notify(options.onUpdate, structuredClone(latest), () =>
      warn("The provisional analysis observer failed; analysis will continue."),
    );
    return structuredClone(latest);
  };

  let revision = 0;
  const provisional = (): AnalysisSnapshot & Details => ({
    ...details,
    phase: "provisional",
    revision,
    fileResults: [...files.values()],
    ruleResults: [...rulesById.values()],
    errors: [],
  });

  let accepting = true;
  const update = (raw: unknown): void => {
    if (!accepting) return;

    const parsed = hooks.schema.safeParse(raw);
    if (!parsed.success) {
      const detail = formatZodIssues(parsed.error, "provisional analysis update").replace(
        /[\r\n\u2028\u2029]+/gu,
        " ",
      );
      warn(`Ignored a provisional analysis update (INVALID_ANALYSIS_UPDATE): ${detail}`);
      return;
    }

    const parsedUpdate = parsed.data;
    const applyUpdate = async (): Promise<void> => {
      if (parsedUpdate.revision <= revision) return;

      try {
        const validateFilePath = (path: string): void => {
          normalizedPath(path);
          if (!files.has(path)) {
            throw new AquariusError(
              "INVALID_RESULT_PATH",
              "A provisional file status is outside the selected targets.",
            );
          }
        };
        const nextFiles = patchReviews(
          files,
          parsedUpdate.fileResults,
          ({ path }) => path,
          validateFilePath,
          "file path",
        );

        const validateRuleId = (id: string): void => {
          if (!rulesById.has(id)) {
            throw new AquariusError(
              "INVALID_RULE_REFERENCE",
              "A provisional review references an unrequested rule.",
            );
          }
        };
        const nextRules = patchReviews(
          rulesById,
          parsedUpdate.ruleResults,
          ({ ruleId }) => ruleId,
          validateRuleId,
          "rule ID",
        );

        details = await hooks.apply(parsedUpdate, details, nextFiles, nextRules);
        files = nextFiles;
        rulesById = nextRules;
        revision = parsedUpdate.revision;
        publish(provisional());
      } catch (cause) {
        const error = toRunError(cause, "INVALID_ANALYSIS_UPDATE");
        warn(`Ignored a provisional analysis update (${error.code}): ${error.message}`);
      }
    };

    pending = pending.then(applyUpdate);
  };

  const close = (
    snapshot: () => AnalysisSnapshot & Details,
  ): Promise<AnalysisSnapshot & Details> => {
    accepting = false;

    const publishAfterPending = async (): Promise<AnalysisSnapshot & Details> => {
      await pending;
      revision += 1;
      return publish({ ...snapshot(), revision });
    };

    const closed = publishAfterPending();
    const waitForClose = async (): Promise<void> => {
      await closed;
    };
    pending = waitForClose();

    return closed;
  };

  const interrupt = (errors: readonly RunError[] = []) =>
    close(() => ({ ...latest, phase: "incomplete", errors: [...errors] }));

  const finish = (response: Response) => {
    const failed = hasFailedReview(response);
    if (failed && hooks.retainIncomplete) return interrupt(response.errors);

    const finalSnapshot = (): AnalysisSnapshot & Details => ({
      ...hooks.final(response),
      phase: failed ? "incomplete" : "final",
      revision,
      fileResults: response.fileResults,
      ruleResults: finalRuleReviews(rules, response),
      errors: response.errors,
    });

    return close(finalSnapshot);
  };

  publish(provisional());

  return { update, flush: () => pending, finish, interrupt };
};

export const notify = <Value>(
  observer: ((value: Value) => void) | undefined,
  value: Value,
  onFailure?: () => void,
): void => {
  try {
    const observerPromise = Promise.resolve(observer?.(value));
    observerPromise.catch(() => onFailure?.());
  } catch {
    onFailure?.();
  }
};

export const pendingFileReview = (path: string): FileReview => ({
  path,
  status: "pending",
  reason: "",
});

export const finalRuleReviews = (
  rules: readonly PreparedRule[],
  response: ReviewResponse,
): RuleReview[] => {
  const skippedReasons = new Map(
    response.skippedRules.map(({ ruleId, reason }) => [ruleId, reason]),
  );
  const fileFailure = response.fileResults.find(({ status }) => status === "failed");

  const reviewRule = ({ id }: PreparedRule): RuleReview => {
    const error = response.errors.find(
      ({ ruleIds }) => ruleIds.length === 0 || ruleIds.includes(id),
    );
    if (error) return { ruleId: id, status: "failed", reason: error.message };

    const reason = skippedReasons.get(id);
    if (reason !== undefined) return { ruleId: id, status: "skipped", reason };

    if (fileFailure && response.errors.length === 0) {
      return { ruleId: id, status: "failed", reason: fileFailure.reason };
    }

    return { ruleId: id, status: "completed", reason: "" };
  };

  return rules.map(reviewRule);
};

const pendingRuleReview = (ruleId: string): RuleReview => ({
  ruleId,
  status: "pending",
  reason: "",
});

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
