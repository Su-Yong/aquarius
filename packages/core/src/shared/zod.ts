import { z } from "zod";

export const nonEmptyStringSchema = z.string().refine((value) => value.trim() !== "", {
  message: "must be a non-empty string",
});

export const jsonObjectSchema = z.record(z.string(), z.json());

export const formatZodIssues = (error: z.ZodError, rootLabel = "configuration"): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : rootLabel;
      if (issue.code === "unrecognized_keys") {
        return `${path} contains unknown field(s): ${issue.keys.join(", ")}`;
      }
      return `${path} ${issue.message}`;
    })
    .join("; ");
