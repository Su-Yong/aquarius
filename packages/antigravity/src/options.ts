import { z } from "zod";

export type EffortHint = "low" | "medium" | "high" | "xhigh" | "max" | (string & {});
export type AntigravityMode = "auto" | "plan";

export interface AntigravityOptions {
  executable?: string;
  model?: string;
  effort?: EffortHint;
  agent?: string;
  mode?: AntigravityMode;
  sandbox?: boolean;
}

const textOption = z.string().trim().min(1).optional();

export const antigravityOptionsSchema = z.strictObject({
  executable: textOption,
  model: textOption,
  effort: textOption,
  agent: textOption,
  mode: z.enum(["auto", "plan"]).optional(),
  sandbox: z.boolean().default(true),
}) satisfies z.ZodType<AntigravityOptions & { sandbox: boolean }, AntigravityOptions>;
