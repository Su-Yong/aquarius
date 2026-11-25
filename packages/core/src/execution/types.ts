import type { z } from "zod";
import type {
  AdapterExecuteRequest,
  AdapterRunInfo,
  AdapterSession,
  AiAdapter,
  RuleResource,
} from "../adapter/types";
import type { PathPolicy, TargetOptions } from "../files/types";
import type { PreparedRule, RulePlugin } from "../rules/types";
import type { JsonObject, RunError, SkippedRule, ToolKind } from "../shared/types";
import type { fileResultSchema, reviewUpdateFields } from "./schemas";

export type FileResult = z.infer<typeof fileResultSchema>;
export interface ReviewUpdate {
  revision: number;
  fileResults: z.infer<typeof reviewUpdateFields.fileResults>;
  ruleResults: z.infer<typeof reviewUpdateFields.ruleResults>;
}
export type FileReview = ReviewUpdate["fileResults"][number];
export type RuleReview = ReviewUpdate["ruleResults"][number];
export type ReviewStatus = FileReview["status"];

export interface ReviewResponse {
  fileResults: FileResult[];
  errors: RunError[];
  skippedRules: SkippedRule[];
  retryable: boolean;
}

export interface AnalysisSnapshot {
  phase: "provisional" | "final" | "incomplete";
  revision: number;
  fileResults: readonly FileReview[];
  ruleResults: readonly RuleReview[];
  errors: readonly RunError[];
}

export interface AnalysisOptions<Details> {
  onUpdate?: (snapshot: AnalysisSnapshot & Details) => void;
  onWarning?: (message: string) => void;
}

export interface Analysis<Details, Response extends ReviewResponse> {
  update: (raw: unknown) => void;
  flush: () => Promise<void>;
  finish: (response: Response) => Promise<AnalysisSnapshot & Details>;
  interrupt: (errors?: readonly RunError[]) => Promise<AnalysisSnapshot & Details>;
}

export interface ToolExecutionOptions<Details> extends TargetOptions {
  cwd: string;
  configPath?: string;
  fileBatchSize?: number;
  maxConcurrency?: number;
  adapter?: AiAdapter;
  plugins?: Record<string, RulePlugin>;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onAdapterInfo?: (info: AdapterRunInfo) => void;
  onWarning?: (message: string) => void;
  onAnalysisUpdate?: (snapshot: AnalysisSnapshot & Details) => void;
}

export interface BatchReviewContext {
  policy: PathPolicy;
  rules: readonly PreparedRule[];
  session: AdapterSession;
  request: Omit<AdapterExecuteRequest, "signal" | "prompt">;
  signal: AbortSignal;
  timeoutMs: number;
}

type BatchReview<Details> = (
  response: ReviewResponse & Details,
  context: BatchReviewContext,
) => Promise<ReviewResponse & Details>;

export interface ToolExecutionHooks<Details extends object, SnapshotDetails extends object> {
  tool: ToolKind;
  continueOnBatchFailure?: boolean;
  retrySingleFileGroup?: boolean;
  afterReviewOnFailure?: boolean;
  reviewProgress: string;
  unreviewedFile: Omit<FileResult, "path">;
  preparationFailedFile: Omit<FileResult, "path">;
  onPreparationError: (errors: readonly RunError[]) => "stop" | "select" | "review";
  empty: Details;
  outputSchema: JsonObject;
  buildPrompt: (
    resources: readonly RuleResource[],
    policy: PathPolicy,
    writeScope: JsonObject,
  ) => string;
  normalize: (
    raw: unknown,
    rules: readonly PreparedRule[],
    policy: PathPolicy,
    resources: readonly RuleResource[],
  ) => (ReviewResponse & Details) | Promise<ReviewResponse & Details>;
  createAnalysis: (
    rules: readonly PreparedRule[],
    policy: PathPolicy,
    resources: readonly RuleResource[],
    options: AnalysisOptions<SnapshotDetails>,
  ) => Analysis<SnapshotDetails, ReviewResponse & Details>;
  merge: (details: readonly Details[]) => Details;
  mergeAnalysis: (details: readonly SnapshotDetails[]) => SnapshotDetails;
  finalDetails?: (response: ReviewResponse & Details) => SnapshotDetails;
  beforeReview?: (policy: PathPolicy) => Promise<void>;
  afterBatch?: BatchReview<Details>;
  afterBatches?: BatchReview<Details>;
  afterReview?: (
    response: ReviewResponse & Details,
    policy: PathPolicy,
    rules: readonly PreparedRule[],
  ) => Promise<ReviewResponse & Details>;
}
