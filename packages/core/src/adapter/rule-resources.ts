import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { formatInstructionsSchema, lintInstructionsSchema } from "../rules/schemas";
import type { PreparedRule } from "../rules/types";
import { AquariusError, isNodeError } from "../shared/errors";
import { safeRelativePath } from "../shared/path";
import type { ToolKind } from "../shared/types";
import { nonEmptyStringSchema } from "../shared/zod";
import { snapshotRoot, writeSnapshotFile } from "./snapshot";
import type { RuleResource } from "./types";

const scopeSchema = z.enum(["file", "module", "project"]);
const resourceSchema = z.strictObject({
  ruleId: nonEmptyStringSchema,
  scope: scopeSchema,
  applicability: nonEmptyStringSchema,
  detailsPath: z.string(),
  content: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

const hash = (content: string): string => createHash("sha256").update(content).digest("hex");

const assertActive = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw new AquariusError("AI_ABORTED", "Rule resource writing was cancelled.");
  }
};

export const buildRuleResources = (
  tool: ToolKind,
  rules: readonly PreparedRule[],
): RuleResource[] => {
  const runDirectory = `.aquarius-rules-${randomUUID()}`;
  const detailSchema = z.strictObject({
    ruleId: nonEmptyStringSchema,
    scope: scopeSchema,
    instructions: tool === "lint" ? lintInstructionsSchema : formatInstructionsSchema,
  });
  const seen = new Set<string>();
  return rules.map((rule) => {
    const parsed = detailSchema.safeParse({
      ruleId: rule.id,
      scope: rule.scope,
      instructions: rule.instructions,
    });
    if (!parsed.success || parsed.data.ruleId !== rule.id || seen.has(rule.id)) {
      throw new AquariusError("INVALID_RULE_RESOURCE", `Invalid or repeated rule: ${rule.id}`);
    }
    seen.add(rule.id);
    const content = `${JSON.stringify(parsed.data, null, 2)}\n`;
    return {
      ruleId: rule.id,
      scope: parsed.data.scope,
      applicability: parsed.data.instructions.applicability,
      detailsPath: `${runDirectory}/${tool}-${hash(rule.id)}.json`,
      content,
      contentHash: hash(content),
    };
  });
};

const checkedResources = (resources: readonly RuleResource[]): RuleResource[] => {
  const parsed = z.array(resourceSchema).safeParse(resources);
  if (!parsed.success) {
    throw new AquariusError("INVALID_RULE_RESOURCE", "Expected valid rule resources.");
  }

  const paths = new Set<string>();
  const names = new Set<string>();
  for (const resource of parsed.data) {
    const path = resource.detailsPath;
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (
      safeRelativePath(path) !== path ||
      !/^\.aquarius-rules-[A-Za-z0-9_-]+\/[^/]+\.json$/u.test(path) ||
      paths.has(key) ||
      names.has(resource.ruleId)
    ) {
      throw new AquariusError(
        "INVALID_RULE_RESOURCE",
        "Invalid or repeated rule resource path or ID.",
      );
    }
    if (hash(resource.content) !== resource.contentHash) {
      throw new AquariusError(
        "RULE_RESOURCE_CHANGED",
        "A rule file does not match its content hash.",
      );
    }
    paths.add(key);
    names.add(resource.ruleId);
  }
  return parsed.data;
};

export const writeRuleResources = async (
  resources: readonly RuleResource[],
  viewRoot: string,
  signal?: AbortSignal,
): Promise<string[]> => {
  assertActive(signal);
  const files = checkedResources(resources);
  const view = await snapshotRoot(viewRoot);
  const directories = new Set<string>();
  for (const file of files) {
    assertActive(signal);
    const directory = file.detailsPath.split("/")[0]!;
    const destination = join(view, file.detailsPath);
    try {
      if (!directories.has(directory)) {
        await mkdir(join(view, directory), { mode: 0o700 });
        directories.add(directory);
      }
      await writeSnapshotFile(destination, file.content, 0o400, signal);
    } catch (error) {
      assertActive(signal);
      if (!isNodeError(error, "EEXIST")) throw error;
      throw new AquariusError(
        "RULE_RESOURCE_CONFLICT",
        `Rule resource conflicts with snapshot content: ${file.detailsPath}`,
      );
    }
  }
  assertActive(signal);
  return files.map(({ detailsPath }) => detailsPath);
};
