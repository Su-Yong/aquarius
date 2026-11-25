import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { formatInstructionsSchema, lintInstructionsSchema } from "../rules/schemas";
import { AquariusError, isNodeError } from "../shared/errors";
import { safeRelativePath } from "../shared/path";
import { nonEmptyStringSchema } from "../shared/zod";
import type { PreparedRule } from "../rules/types";
import type { ToolKind } from "../shared/types";

import { snapshotRoot, writeSnapshotFile } from "./snapshot";
import type { RuleResource } from "./types";

const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const RULE_RESOURCE_PATH_PATTERN = /^\.aquarius-rules-[A-Za-z0-9_-]+\/[^/]+\.json$/u;
const scopeSchema = z.enum(["file", "module", "project"]);
const resourceSchema = z.strictObject({
  ruleId: nonEmptyStringSchema,
  scope: scopeSchema,
  applicability: nonEmptyStringSchema,
  detailsPath: z.string(),
  content: z.string(),
  contentHash: z.string().regex(CONTENT_HASH_PATTERN),
});

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

  const buildRuleResource = (rule: PreparedRule): RuleResource => {
    const parsed = detailSchema.safeParse({
      ruleId: rule.id,
      scope: rule.scope,
      instructions: rule.instructions,
    });
    const isInvalidOrRepeated =
      !parsed.success || parsed.data.ruleId !== rule.id || seen.has(rule.id);
    if (isInvalidOrRepeated) {
      throw new AquariusError("INVALID_RULE_RESOURCE", `Invalid or repeated rule: ${rule.id}`);
    }

    seen.add(rule.id);
    const content = `${JSON.stringify(parsed.data, null, 2)}\n`;
    return {
      ruleId: rule.id,
      scope: parsed.data.scope,
      applicability: parsed.data.instructions.applicability,
      detailsPath: `${runDirectory}/${tool}-${hashContent(rule.id)}.json`,
      content,
      contentHash: hashContent(content),
    };
  };

  return rules.map(buildRuleResource);
};

export const writeRuleResources = async (
  resources: readonly RuleResource[],
  viewRoot: string,
  signal?: AbortSignal,
): Promise<string[]> => {
  assertActive(signal);
  const files = validateRuleResources(resources);

  const view = await snapshotRoot(viewRoot);
  const directories = new Set<string>();

  for (const file of files) {
    assertActive(signal);

    const pathSegments = file.detailsPath.split("/");
    const directory = pathSegments[0]!;
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

const hashContent = (content: string): string => {
  const hash = createHash("sha256");
  return hash.update(content).digest("hex");
};

const assertActive = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw new AquariusError("AI_ABORTED", "Rule resource writing was cancelled.");
  }
};

const validateRuleResources = (resources: readonly RuleResource[]): RuleResource[] => {
  const resourcesSchema = z.array(resourceSchema);
  const parsed = resourcesSchema.safeParse(resources);
  if (!parsed.success) {
    throw new AquariusError("INVALID_RULE_RESOURCE", "Expected valid rule resources.");
  }

  const pathKeys = new Set<string>();
  const ruleIds = new Set<string>();

  for (const resource of parsed.data) {
    const path = resource.detailsPath;
    const pathKey = process.platform === "win32" ? path.toLowerCase() : path;

    const isInvalidOrRepeated =
      safeRelativePath(path) !== path ||
      !RULE_RESOURCE_PATH_PATTERN.test(path) ||
      pathKeys.has(pathKey) ||
      ruleIds.has(resource.ruleId);
    if (isInvalidOrRepeated) {
      throw new AquariusError(
        "INVALID_RULE_RESOURCE",
        "Invalid or repeated rule resource path or ID.",
      );
    }

    if (hashContent(resource.content) !== resource.contentHash) {
      throw new AquariusError(
        "RULE_RESOURCE_CHANGED",
        "A rule file does not match its content hash.",
      );
    }

    pathKeys.add(pathKey);
    ruleIds.add(resource.ruleId);
  }

  return parsed.data;
};
