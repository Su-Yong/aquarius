import { AquariusError } from "@aquarius/core/runtime";

import type { ReplaceChange } from "./schema";
import type { FileState } from "./types";

type PatchErrorCode =
  | "REPLACE_PATCH_INVALID"
  | "REPLACE_RANGE_INVALID"
  | "REPLACE_MISMATCH"
  | "REPLACE_OVERLAP";

interface PatchLine {
  prefix: " " | "-" | "+";
  text: string;
  noNewline?: true;
}

interface Hunk {
  changeIndex: number;
  hunkIndex: number;
  patchLine: number;
  ruleIds: string[];
  oldStart: number;
  newStart: number;
  lines: PatchLine[];
  oldLines: PatchLine[];
  newCount: number;
}

interface LocatedHunk extends Hunk {
  start: number;
  end: number;
  priorPatchDelta: number;
}

interface SourceLine {
  text: string;
  ending: "" | "\n" | "\r\n";
}

interface OutputLine extends SourceLine {
  noNewline?: LocatedHunk;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const hunkHeader = /^@@ -(-?\d+)(?:,\d+)? \+(-?\d+)(?:,\d+)? @@(?: .*)?$/;
const noNewlineMarker = "\\ No newline at end of file";
const offsetWindow = 3;
const patchLineSeparator = /\r?\n/;
const gitMetadataPrefix = /^(?:index|old mode|new mode|new file mode|deleted file mode) /;

export class ReplacementPatchError extends AquariusError {
  readonly ruleIds: string[];

  constructor(code: PatchErrorCode, message: string, ruleIds: readonly string[]) {
    super(code, message);
    this.ruleIds = [...new Set(ruleIds)];
  }
}

export const applyReplacementPatches = (
  relativePath: string,
  state: FileState,
  replacements: readonly ReplaceChange[],
): FileState => {
  if (!replacements.length) return { ...state, content: new Uint8Array(state.content) };

  const original = decodeSource(relativePath, state);
  const hasBom = original.startsWith("\uFEFF");
  const source = readSourceLines(hasBom ? original.slice(1) : original);
  const ending = source.find((line) => line.ending)?.ending || "\n";
  const patchDeltas: number[] = [];

  const locateChangeHunks = (change: ReplaceChange, changeIndex: number): LocatedHunk[] => {
    let lineDelta = 0;
    const locatedHunks = readHunks(relativePath, change, changeIndex).map((hunk) => {
      const located = locateHunk(relativePath, source, hasBom, hunk, lineDelta);
      lineDelta += hunk.newCount - hunk.oldLines.length;
      return located;
    });
    patchDeltas.push(lineDelta);
    return locatedHunks;
  };

  const hunks = replacements.flatMap(locateChangeHunks);
  hunks.sort((left, right) => left.start - right.start || left.end - right.end);
  assertNonoverlapping(relativePath, hunks);

  const totalDelta = patchDeltas.reduce((sum, delta) => sum + delta, 0);
  const output: OutputLine[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const { start, newStart } = hunk;
    if (hunk.oldLines.length === 0) {
      // Separate patch strings can use their own new coordinates or those of one split diff.
      const patchDelta = patchDeltas[hunk.changeIndex]!;
      const maxOutputLength = source.length + Math.max(totalDelta, patchDelta);
      if (newStart > maxOutputLength) {
        throw hunkError(
          "REPLACE_RANGE_INVALID",
          relativePath,
          source,
          hunk,
          `New hunk line number +${newStart} is outside the valid range.`,
        );
      }
      if (
        newStart !== start + hunk.priorPatchDelta + 1 &&
        newStart !== output.length + (start - cursor) + 1
      ) {
        throw hunkError(
          "REPLACE_MISMATCH",
          relativePath,
          source,
          hunk,
          "Pure insertion coordinates do not identify the same boundary.",
        );
      }
    }

    while (cursor < hunk.start) output.push(source[cursor++]!);
    for (const line of hunk.lines) {
      if (line.prefix === "-") {
        cursor += 1;
        continue;
      }

      const next =
        line.prefix === " "
          ? source[cursor++]!
          : buildAddedLine(line, hasBom && output.length === 0, ending);
      output.push(line.noNewline ? { ...next, noNewline: hunk } : next);
    }
  }
  while (cursor < source.length) output.push(source[cursor++]!);

  const finalEnding = source.at(-1)?.ending ?? (output.at(-1)?.noNewline ? "" : ending);
  const renderOutputLine = (line: OutputLine, index: number): string => {
    const final = index === output.length - 1;
    if (line.noNewline && (!final || finalEnding)) {
      const reason = final
        ? "The no-newline marker would remove the original final newline."
        : "The no-newline marker must describe the last output line.";
      throw new ReplacementPatchError(
        "REPLACE_PATCH_INVALID",
        `${relativePath}: ${hunkLabel(line.noNewline)}: ${reason}`,
        line.noNewline.ruleIds,
      );
    }
    return line.text + (final ? finalEnding : line.ending || ending);
  };

  const transformed = output.map(renderOutputLine).join("");
  return { content: encoder.encode((hasBom ? "\uFEFF" : "") + transformed), mode: state.mode };
};

const decodeSource = (relativePath: string, state: FileState): string => {
  try {
    return decoder.decode(state.content);
  } catch {
    throw new AquariusError(
      "FILE_ENCODING_UNSUPPORTED",
      `Replacement requires valid UTF-8 text: ${relativePath}`,
    );
  }
};

const readHunks = (path: string, change: ReplaceChange, changeIndex: number): Hunk[] => {
  const invalid = (index: number, message: string): never => {
    throw new ReplacementPatchError(
      "REPLACE_PATCH_INVALID",
      `${path}: patch ${changeIndex + 1}, line ${index + 1}: ${message}`,
      change.ruleIds,
    );
  };

  const lines = change.patch.split(patchLineSeparator);
  while (lines.at(-1) === "") lines.pop();

  let cursor = 0;
  if (lines[cursor]?.startsWith("diff --git ")) {
    cursor += 1;
    while (gitMetadataPrefix.test(lines[cursor] ?? "")) {
      cursor += 1;
    }
  }
  if (lines[cursor]?.startsWith("--- ")) {
    cursor += 1;
    if (!lines[cursor]?.startsWith("+++ ")) invalid(cursor, "Expected the paired +++ file header.");
    cursor += 1;
  }

  const hunks: Hunk[] = [];
  while (cursor < lines.length) {
    const header = hunkHeader.exec(lines[cursor]!) ?? invalid(cursor, "Expected a hunk header.");
    const hunk: Hunk = {
      changeIndex,
      hunkIndex: hunks.length,
      patchLine: cursor + 1,
      ruleIds: change.ruleIds,
      oldStart: Number(header[1]),
      newStart: Number(header[2]),
      lines: [],
      oldLines: [],
      newCount: 0,
    };

    cursor += 1;
    let nextHunk = cursor;
    while (nextHunk < lines.length && !lines[nextHunk]!.startsWith("@@")) nextHunk += 1;

    // Bare blanks at the boundary are separators, while interior blanks are context.
    let bodyEnd = nextHunk;
    while (bodyEnd > cursor && lines[bodyEnd - 1] === "") bodyEnd -= 1;

    let oldNoNewline = false;
    let newNoNewline = false;
    while (cursor < bodyEnd) {
      const line = lines[cursor]!;
      const prefix = line === "" ? " " : line[0];
      if (prefix === " " || prefix === "-" || prefix === "+") {
        if ((prefix !== "+" && oldNoNewline) || (prefix !== "-" && newNoNewline)) {
          invalid(cursor, "No hunk lines may follow a no-newline marker on the same side.");
        }
        const entry: PatchLine = { prefix, text: line.slice(1) };
        hunk.lines.push(entry);
        if (prefix !== "+") hunk.oldLines.push(entry);
        if (prefix !== "-") hunk.newCount += 1;
      } else if (line === noNewlineMarker) {
        const invalidMarker = () =>
          invalid(cursor, "The no-newline marker must follow a hunk body line.");
        const previous = hunk.lines.at(-1) ?? invalidMarker();
        if (previous.noNewline) invalidMarker();
        previous.noNewline = true;
        if (previous.prefix !== "+") oldNoNewline = true;
        if (previous.prefix !== "-") newNoNewline = true;
      } else {
        invalid(cursor, "Expected a context, deletion, or addition line.");
      }
      cursor += 1;
    }

    cursor = nextHunk;
    if (hunk.lines.length === 0) invalid(hunk.patchLine - 1, "The hunk body is empty.");
    hunks.push(hunk);
  }

  if (hunks.length === 0) invalid(cursor, "Expected at least one hunk.");

  return hunks;
};

const readSourceLines = (text: string): SourceLine[] => {
  if (text === "") return [];

  const lines = text.split("\n");
  const hasFinalNewline = lines.at(-1) === "";
  if (hasFinalNewline) lines.pop();

  return lines.map((line, index) => {
    if (index === lines.length - 1 && !hasFinalNewline) return { text: line, ending: "" };
    return line.endsWith("\r")
      ? { text: line.slice(0, -1), ending: "\r\n" }
      : { text: line, ending: "\n" };
  });
};

const hunkLabel = (hunk: Hunk): string =>
  `patch ${hunk.changeIndex + 1}, hunk ${hunk.hunkIndex + 1} (patch line ${hunk.patchLine})`;

const sourceSnippet = (source: readonly SourceLine[], start: number): string => {
  if (!source.length) return "Original source is empty.";

  const lastSourceIndex = source.length - 1;
  const boundedStart = Math.min(start, lastSourceIndex);
  const center = Math.max(0, boundedStart);
  const from = Math.max(0, center - offsetWindow);
  const to = Math.min(source.length, center + offsetWindow + 1);

  return source
    .slice(from, to)
    .map(({ text }, index) => `${from + index + 1} | ${text}`)
    .join("\n");
};

const hunkError = (
  code: PatchErrorCode,
  path: string,
  source: readonly SourceLine[],
  hunk: Hunk,
  message: string,
): ReplacementPatchError =>
  new ReplacementPatchError(
    code,
    `${path}: ${hunkLabel(hunk)} at original line ${hunk.oldStart}: ${message}\n${sourceSnippet(source, hunk.oldStart - 1)}`,
    hunk.ruleIds,
  );

const locateHunk = (
  path: string,
  source: readonly SourceLine[],
  hasBom: boolean,
  hunk: Hunk,
  priorPatchDelta: number,
): LocatedHunk => {
  const { oldLines, newCount } = hunk;
  // Unified Diff numbers an empty old range after the given line, and a nonempty range from it.
  const start = oldLines.length === 0 ? hunk.oldStart : hunk.oldStart - 1;

  const reject = (code: PatchErrorCode, message: string): never => {
    throw hunkError(code, path, source, hunk, message);
  };

  const invalidLineNumbers =
    !Number.isSafeInteger(start) ||
    start < 0 ||
    start > source.length ||
    (oldLines.length > 0 && start === source.length) ||
    !Number.isSafeInteger(hunk.newStart) ||
    hunk.newStart < (newCount > 0 ? 1 : 0);
  if (invalidLineNumbers) {
    reject(
      "REPLACE_RANGE_INVALID",
      `Hunk line numbers (-${hunk.oldStart}, +${hunk.newStart}) are outside the valid range.`,
    );
  }

  const matches = (position: number): boolean => {
    const matchesOriginalLine = ({ text, noNewline }: PatchLine, offset: number): boolean => {
      const index = position + offset;
      const actual = source[index];
      if (!actual) return false;
      const textMatches =
        actual.text === text ||
        (hasBom && index === 0 && text.startsWith("\uFEFF") && actual.text === text.slice(1));
      return textMatches && (!noNewline || actual.ending === "");
    };
    return oldLines.every(matchesOriginalLine);
  };

  if (oldLines.length === 0 || matches(start)) {
    return { ...hunk, start, end: start + oldLines.length, priorPatchDelta };
  }

  const lastStart = source.length - oldLines.length;
  let match: number | undefined;
  for (
    let index = Math.max(0, start - offsetWindow);
    index <= Math.min(lastStart, start + offsetWindow);
    index += 1
  ) {
    if (!matches(index)) continue;
    if (match !== undefined)
      reject("REPLACE_MISMATCH", "Original hunk text matches multiple positions within ±3 lines.");
    match = index;
  }

  if (match !== undefined) {
    return { ...hunk, start: match, end: match + oldLines.length, priorPatchDelta };
  }
  if (start > lastStart) reject("REPLACE_RANGE_INVALID", "Hunk extends beyond the original file.");
  return reject("REPLACE_MISMATCH", "Original hunk text does not match within ±3 lines.");
};

const describeRange = ({ start, end }: LocatedHunk): string =>
  start === end ? `after original line ${start}` : `original lines ${start + 1}-${end}`;

const assertNonoverlapping = (path: string, hunks: readonly LocatedHunk[]): void => {
  for (let index = 1; index < hunks.length; index += 1) {
    const previous = hunks[index - 1]!;
    const current = hunks[index]!;
    if (
      current.start < previous.end ||
      (previous.start === current.start && previous.end === current.end)
    ) {
      const describe = (hunk: LocatedHunk): string =>
        `${hunkLabel(hunk)} [${hunk.ruleIds.join(", ")}], ${describeRange(hunk)}`;

      throw new ReplacementPatchError(
        "REPLACE_OVERLAP",
        `${path}: overlapping hunks: ${describe(previous)}; ${describe(current)}`,
        [...previous.ruleIds, ...current.ruleIds],
      );
    }
  }
};

const buildAddedLine = (
  line: PatchLine,
  stripBom: boolean,
  ending: SourceLine["ending"],
): SourceLine => {
  const hasLeadingBom = stripBom && line.text.startsWith("\uFEFF");
  const text = hasLeadingBom ? line.text.slice(1) : line.text;
  return { text, ending };
};
