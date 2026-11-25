import { expect, test } from "vitest";
import { applyReplacementPatches } from "../src/changes/patch";
import type { ReplaceChange } from "../src/changes/schema";

const path = "src/sample.txt";
const replacement = (patch: string, ...ruleIds: string[]): ReplaceChange => ({
  op: "replace",
  path,
  patch,
  ruleIds: ruleIds.length ? ruleIds : ["fmt/main"],
});
const apply = (source: string, ...patches: ReplaceChange[]): string =>
  Buffer.from(
    applyReplacementPatches(path, { content: Buffer.from(source), mode: 0o644 }, patches).content,
  ).toString();

test("recounts hunk headers and uses the declared position among duplicate source lines", () => {
  const patch = [
    "diff --git a/src/sample.txt b/src/sample.txt",
    "index aaaaaaa..bbbbbbb 100644",
    "--- a/src/sample.txt",
    "+++ b/src/sample.txt",
    "@@ -3,78 +3,0 @@ function",
    "-repeat",
    "+third",
    "@@ -5 +5,90 @@",
    " middle",
    "-end",
    "+last",
  ].join("\n");
  expect(apply("repeat\nother\nrepeat\nnext\nmiddle\nend\n", replacement(patch))).toBe(
    "repeat\nother\nthird\nnext\nmiddle\nlast\n",
  );
});

test("accepts extra blank separators and bare blank context lines", () => {
  const patch = [
    "@@ -1,4 +1,4 @@",
    " before",
    "",
    "",
    "-old",
    "+new",
    "",
    "",
    "@@ -6,2 +6,2 @@",
    "-later",
    "+LATER",
    " ",
    "",
    "",
  ].join("\n");
  expect(apply("before\n\n\nold\nbetween\nlater\n\n", replacement(patch))).toBe(
    "before\n\n\nnew\nbetween\nLATER\n\n",
  );
});

test("handles deletion and pure insertions at the front, between lines, and at the end", () => {
  const patch = [
    "@@ -0,0 +1 @@",
    "+first",
    "@@ -2,0 +4 @@",
    "+middle",
    "@@ -3 +4,0 @@",
    "-remove",
    "@@ -4,0 +6 @@",
    "+last",
  ].join("\n");
  expect(apply("one\ntwo\nremove\nthree\n", replacement(patch))).toBe(
    "first\none\ntwo\nmiddle\nthree\nlast\n",
  );
  expect(apply("", replacement("@@ -0,0 +1,2 @@\n+first\n+last\n"))).toBe("first\nlast\n");
  expect(apply("only\n", replacement("@@ -1 +0,0 @@\n-only\n"))).toBe("");
});

test("accepts original-line output coordinates when source text fixes the hunk location", () => {
  const source = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
  const deleteFront = "@@ -1,4 +0,0 @@\n-one\n-two\n-three\n-four\n";
  const editNearEnd = "@@ -9,1 +9,1 @@\n-nine\n+NINE\n";
  expect(apply(source, replacement(deleteFront + editNearEnd))).toBe(
    "five\nsix\nseven\neight\nNINE\nten\n",
  );
  expect(apply(source, replacement("@@ -9,2 +9,0 @@\n-nine\n-ten\n"))).toBe(
    "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n",
  );
  expect(apply("one\ntwo\n", replacement("@@ -1,2 +1,0 @@\n-one\n-two\n"))).toBe("");
  expect(apply("a\nb\n", replacement("@@ -1 +3 @@\n-a\n+A"))).toBe("A\nb\n");
});

test("locates different patches against the original even when an earlier patch adds lines", () => {
  expect(
    apply(
      "one\ntwo\nthree\n",
      replacement("@@ -2,0 +3 @@\n+extra", "fmt/a"),
      replacement("@@ -3 +3 @@\n-three\n+THREE", "fmt/b"),
    ),
  ).toBe("one\ntwo\nextra\nTHREE\n");
  expect(
    apply(
      "one\ntwo\nthree\n",
      replacement("@@ -1 +1,2 @@\n-one\n+ONE\n+extra", "fmt/a"),
      replacement("@@ -2,0 +4 @@\n+insert", "fmt/b"),
    ),
  ).toBe("ONE\nextra\ntwo\ninsert\nthree\n");
});

test("repairs only a unique contextual match within three original lines", () => {
  expect(apply("a\nb\nc\nd\ne\nf\n", replacement("@@ -2 +2 @@\n-e\n+E"))).toBe(
    "a\nb\nc\nd\nE\nf\n",
  );
  expect(apply("a\nb\nc\nd\ne\nf\n", replacement("@@ -5,3 +5 @@\n-b\n-c\n-d\n+B"))).toBe(
    "a\nB\ne\nf\n",
  );
  expect(() => apply("a\nb\nc\nd\ne\nf\n", replacement("@@ -1 +1 @@\n-e\n+E"))).toThrow(
    expect.objectContaining({
      code: "REPLACE_MISMATCH",
      message: expect.stringContaining("1 | a"),
    }),
  );
  expect(() => apply("a\nmatch\nb\nmatch\nc\n", replacement("@@ -3 +3 @@\n-match\n+M"))).toThrow(
    expect.objectContaining({
      code: "REPLACE_MISMATCH",
      message: expect.stringContaining("multiple positions"),
    }),
  );
  expect(() => apply("a\nb\n", replacement("@@ -1,0 +3 @@\n+insert"))).toThrow(
    expect.objectContaining({ code: "REPLACE_MISMATCH" }),
  );
  expect(() => apply("a\nb\n", replacement("@@ -3,0 +4 @@\n+insert"))).toThrow(
    expect.objectContaining({
      code: "REPLACE_RANGE_INVALID",
      message: expect.stringContaining("2 | b"),
    }),
  );
  expect(() => apply("a\nb\n", replacement("@@ --1 +1 @@\n-a\n+A"))).toThrow(
    expect.objectContaining({ code: "REPLACE_RANGE_INVALID" }),
  );
});

test.each([
  "@@ -1 +0 @@\n-a\n+A",
  "@@ -1 +-1 @@\n-a\n+A",
  "@@ -1 +-1,0 @@\n-a",
  "@@ -1,0 +0 @@\n+insert",
  "@@ -1,0 +99 @@\n+insert",
])("rejects invalid output coordinates in patch %j", (patch) => {
  expect(() => apply("a\nb\n", replacement(patch))).toThrow(
    expect.objectContaining({ code: "REPLACE_RANGE_INVALID" }),
  );
});

test("reports only overlapping hunks and their rules after resolving original ranges", () => {
  expect(() =>
    apply(
      "one\ntwo\nthree\nfour\n",
      replacement("@@ -4 +4 @@\n-four\n+FOUR", "fmt/unrelated"),
      replacement("@@ -1,2 +1 @@\n one\n-two\n+TWO", "fmt/a", "fmt/shared"),
      replacement("@@ -3 +3 @@\n-two\n+also TWO", "fmt/b", "fmt/shared"),
    ),
  ).toThrow(
    expect.objectContaining({
      code: "REPLACE_OVERLAP",
      ruleIds: ["fmt/a", "fmt/shared", "fmt/b"],
      message: expect.stringMatching(
        /patch 2, hunk 1.*original lines 1-2.*patch 3, hunk 1.*original lines 2-2/,
      ),
    }),
  );
  expect(() =>
    apply("a\nb\n", replacement("@@ -1,0 +2 @@\n+first"), replacement("@@ -1,0 +2 @@\n+second")),
  ).toThrow(expect.objectContaining({ code: "REPLACE_OVERLAP" }));
});

test.each([
  "",
  "--- x\n+++ y\n",
  "@@ -1 +1 @@\n",
  "@@ -1 +1 @@\ninvalid\n",
  "@@ hint @@\n-old\n+new\n",
  "@@ -1 +1 @@\n\\ No newline at end of file\n",
  "@@ -1,2 +1 @@\n-old\n\\ No newline at end of file\n-another\n+new\n",
  "@@ -1,2 +1 @@\n-old\n\\ No newline at end of file\n\n+new\n",
])("rejects malformed patch %j with the responsible patch and line", (patch) => {
  expect(() => apply("old", replacement(patch, "fmt/parse"))).toThrow(
    expect.objectContaining({
      code: "REPLACE_PATCH_INVALID",
      ruleIds: ["fmt/parse"],
      message: expect.stringMatching(/patch 1, line \d/),
    }),
  );
});

test("preserves BOM, CRLF, and terminal newline state with or without explicit markers", () => {
  const marker = "\\ No newline at end of file";
  expect(
    apply("\uFEFFold\r\nnext\r\n", replacement("@@ -1 +1 @@\r\n-\uFEFFold\r\n+\uFEFFnew\r\n")),
  ).toBe("\uFEFFnew\r\nnext\r\n");
  expect(
    apply(
      "\uFEFFfirst\r\nold",
      replacement(["@@ -2 +2 @@", "-old", marker, "+new", marker].join("\n")),
    ),
  ).toBe("\uFEFFfirst\r\nnew");
  expect(apply("old", replacement("@@ -1 +1 @@\n-old\n+new"))).toBe("new");
  expect(apply("old", replacement("@@ -1,0 +2 @@\n+new"))).toBe("old\nnew");
  expect(apply("", replacement(["@@ -0,0 +1 @@", "+new", marker].join("\n")))).toBe("new");
  expect(() =>
    apply("old\n", replacement(["@@ -1 +1 @@", "-old", "+new", marker].join("\n"))),
  ).toThrow(expect.objectContaining({ code: "REPLACE_PATCH_INVALID" }));
  expect(() =>
    apply("old\nnext\n", replacement(["@@ -1 +1 @@", "-old", "+new", marker].join("\n"))),
  ).toThrow(expect.objectContaining({ code: "REPLACE_PATCH_INVALID" }));
});

test("keeps a leading U+FEFF explicitly added to a source without a BOM", () => {
  expect(apply("old\n", replacement("@@ -1 +1 @@\n-old\n+\uFEFFnew\n"))).toBe("\uFEFFnew\n");
});

test("rejects invalid UTF-8 for a replacement and preserves raw bytes without a replacement", () => {
  const state = { content: Uint8Array.of(0xff, 0xfe), mode: 0o755 };
  expect(() => applyReplacementPatches(path, state, [replacement("@@ -1 +1 @@\n-a\n+b")])).toThrow(
    expect.objectContaining({ code: "FILE_ENCODING_UNSUPPORTED" }),
  );
  expect(applyReplacementPatches(path, state, [])).toEqual(state);
});
