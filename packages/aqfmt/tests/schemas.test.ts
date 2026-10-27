import { expect, test } from "vitest";
import { fileChangeSchema, formatResponseJsonSchema, formatResponseSchema } from "../src/format/schemas";
import { parseUndoManifest } from "../src/undo/schema";

test("format response schema is strict and produces the AI JSON schema", () => {
  const response = {
    completedRuleIds: ["style/early-return"],
    changes: [{
      op: "replace",
      path: "src/file.ts",
      oldText: "before",
      newText: "after",
      ruleIds: ["style/early-return"],
    }],
    warnings: [],
    errors: [],
  };

  expect(formatResponseSchema.safeParse(response).success).toBe(true);
  expect(formatResponseSchema.safeParse({ ...response, unexpected: true }).success).toBe(false);
  expect(formatResponseJsonSchema).toMatchObject({ type: "object", additionalProperties: false });
});

test("format AI schema uses Codex-compatible unions with strict operation fields", () => {
  expect(formatResponseJsonSchema).toMatchObject({
    properties: {
      changes: {
        items: {
          anyOf: [
            { properties: { op: { const: "replace" } }, required: ["op", "path", "oldText", "newText", "ruleIds"], additionalProperties: false },
            { properties: { op: { const: "create" } }, required: ["op", "path", "content", "ruleIds"], additionalProperties: false },
            { properties: { op: { const: "delete" } }, required: ["op", "path", "ruleIds"], additionalProperties: false },
            { properties: { op: { const: "move" } }, required: ["op", "from", "to", "ruleIds"], additionalProperties: false },
          ],
        },
      },
    },
  });
  expect(JSON.stringify(formatResponseJsonSchema)).not.toContain('"oneOf"');
});

test.each([
  { op: "replace", path: "src/file.ts", oldText: "before", newText: "after", ruleIds: ["style/early-return"] },
  { op: "create", path: "src/file.ts", content: "created", ruleIds: ["style/early-return"] },
  { op: "delete", path: "src/file.ts", ruleIds: ["style/early-return"] },
  { op: "move", from: "src/file.ts", to: "src/moved.ts", ruleIds: ["style/early-return"] },
])("file change schema preserves strict validation for $op", (change) => {
  expect(fileChangeSchema.parse(change)).toEqual(change);
  expect(fileChangeSchema.safeParse({ ...change, unexpected: true }).success).toBe(false);
  expect(fileChangeSchema.safeParse({ ...change, op: "unknown" }).success).toBe(false);
  for (const field of Object.keys(change)) {
    const missingField = { ...change };
    delete missingField[field as keyof typeof missingField];
    expect(fileChangeSchema.safeParse(missingField).success).toBe(false);
    expect(fileChangeSchema.safeParse({ ...change, [field]: 1 }).success).toBe(false);
  }
});

test("undo manifest schema rejects malformed and empty state records", () => {
  const root = process.cwd();
  expect(() => parseUndoManifest({ version: 1, projectRoot: root, files: "invalid", createdDirectories: [] }, root))
    .toThrow(expect.objectContaining({ code: "UNDO_RECORD_INVALID" }));
  expect(() => parseUndoManifest({
    version: 1,
    projectRoot: root,
    files: [{ path: "src/file.ts", before: null, after: null }],
    createdDirectories: [],
  }, root)).toThrow(expect.objectContaining({ code: "UNDO_RECORD_INVALID" }));
});
