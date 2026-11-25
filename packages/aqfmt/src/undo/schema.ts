import { z } from "zod";

import { AquariusError } from "@aquarius/core/runtime";

export type StoredFileState = z.infer<typeof storedFileStateSchema>;
export type StoredFile = z.infer<typeof storedFileSchema>;
export type UndoManifest = z.infer<typeof undoManifestSchema>;

const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/;

const storedFileStateSchema = z.strictObject({
  blob: z.string().regex(GIT_OBJECT_ID_PATTERN),
  mode: z.number().int().min(0).max(0o777),
});

const storedFileSchema = z.strictObject({
  path: z.string().min(1),
  before: storedFileStateSchema.nullable(),
  after: storedFileStateSchema.nullable(),
});

export const undoManifestSchema = z.strictObject({
  version: z.literal(1),
  projectRoot: z.string().min(1),
  files: z.array(storedFileSchema),
  createdDirectories: z.array(z.string()),
});

export const parseUndoManifest = (value: unknown, expectedRoot: string): UndoManifest => {
  const parsed = undoManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AquariusError(
      "UNDO_RECORD_INVALID",
      `Undo record structure is invalid: ${parsed.error.message}`,
    );
  }
  if (parsed.data.projectRoot !== expectedRoot) {
    throw new AquariusError("UNDO_RECORD_INVALID", "Undo record project root does not match");
  }

  const seenPaths = new Set<string>();
  for (const file of parsed.data.files) {
    const pathKey = process.platform === "win32" ? file.path.toLowerCase() : file.path;
    if (seenPaths.has(pathKey))
      throw new AquariusError("UNDO_RECORD_INVALID", `Duplicate undo path: ${file.path}`);
    if (file.before === null && file.after === null) {
      throw new AquariusError("UNDO_RECORD_INVALID", `Undo path has no state: ${file.path}`);
    }

    seenPaths.add(pathKey);
  }

  return parsed.data;
};
