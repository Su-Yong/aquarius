import { describe, expect, test, vi } from "vitest";
import type { FileReview, PathPolicy, PreparedRule, RuleResource } from "@aquarius/core/runtime";
import { createFormatAnalysis } from "../src/format/analysis";
import type { FormatAnalysisUpdate } from "../src/format/schemas";
import type { FormatAnalysisSnapshot, FormatResponse, FormatWarning } from "../src/format/types";

const rules: PreparedRule[] = ["first", "second"].map((name) => ({
  id: `fixture/${name}`,
  scope: "file",
  instructions: {
    applicability: "Source files",
    transformation: "Preserve behavior while simplifying branches.",
    constraints: [],
  },
}));

const policy: PathPolicy = {
  projectRoot: "/project",
  targets: ["a.ts", "b.ts"],
  readableFiles: ["a.ts", "b.ts", "README.md"],
  isIgnored: (path) => path === "ignored.ts",
  canWrite: (path) => ["a.ts", "b.ts", "new.ts", "rule-resources/first.json"].includes(path),
};

const resources: RuleResource[] = rules.map((rule) => ({
  ruleId: rule.id,
  scope: rule.scope,
  applicability: "Source files",
  detailsPath: `rule-resources/${rule.id.split("/")[1]}.json`,
  content: "{}",
  contentHash: "fixture",
}));

const warning = (
  message = "A transformation needs more context.",
  paths = ["a.ts"],
): FormatWarning => ({
  code: "PRESERVATION_UNCERTAIN",
  ruleIds: ["fixture/first"],
  message,
  paths,
});

const update = (
  revision: number,
  changes: Partial<FormatAnalysisUpdate> = {},
): FormatAnalysisUpdate => ({
  type: "aquarius.analysis_update",
  revision,
  fileResults: [],
  ruleResults: [],
  proposedFiles: [],
  warnings: [],
  ...changes,
});

const response = (changes: Partial<FormatResponse> = {}): FormatResponse => ({
  changes: [
    {
      op: "replace",
      path: "b.ts",
      patch: "@@ -1 +1 @@\n-old\n+new\n",
      ruleIds: ["fixture/first"],
    },
  ],
  warnings: [warning("Final warning", ["b.ts"])],
  errors: [],
  skippedRules: [{ ruleId: "fixture/second", reason: "No matching code." }],
  fileResults: [
    { path: "a.ts", status: "skipped", reason: "No matching code." },
    { path: "b.ts", status: "completed", reason: "" },
  ],
  retryable: false,
  ...changes,
});

const observe = (selectedRules = rules) => {
  const snapshots: FormatAnalysisSnapshot[] = [];
  const onWarning = vi.fn();
  const analysis = createFormatAnalysis(selectedRules, policy, resources, {
    onUpdate: (snapshot) => snapshots.push(snapshot),
    onWarning,
  });
  return { analysis, snapshots, onWarning };
};

describe("provisional formatting analysis", () => {
  test("starts every file and rule pending without inferring completed work", async () => {
    const { analysis, snapshots } = observe();
    await analysis.flush();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({
      phase: "provisional",
      revision: 0,
      fileResults: [
        { path: "a.ts", status: "pending", reason: "" },
        { path: "b.ts", status: "pending", reason: "" },
      ],
      ruleResults: [
        { ruleId: "fixture/first", status: "pending", reason: "" },
        { ruleId: "fixture/second", status: "pending", reason: "" },
      ],
      proposedFiles: [],
      warnings: [],
      errors: [],
    });
  });

  test("patches review states but replaces proposals and warnings on every update", async () => {
    const { analysis, snapshots } = observe();
    analysis.update(
      update(1, {
        fileResults: [{ path: "a.ts", status: "in_progress", reason: "Checking branches." }],
        ruleResults: [{ ruleId: "fixture/first", status: "in_progress", reason: "" }],
        proposedFiles: ["a.ts"],
        warnings: [warning()],
      }),
    );
    analysis.update(
      update(2, {
        fileResults: [{ path: "a.ts", status: "completed", reason: "" }],
        ruleResults: [{ ruleId: "fixture/first", status: "completed", reason: "" }],
        proposedFiles: ["b.ts"],
        warnings: [warning("Revised warning", ["b.ts"])],
      }),
    );
    analysis.update(update(3));
    await analysis.flush();

    expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([0, 1, 2, 3]);
    expect(snapshots[1]!.proposedFiles).toEqual(["a.ts"]);
    expect(snapshots[2]!.proposedFiles).toEqual(["b.ts"]);
    expect(snapshots[2]!.warnings[0]!.message).toBe("Revised warning");
    expect(snapshots[3]!.proposedFiles).toEqual([]);
    expect(snapshots[3]!.warnings).toEqual([]);
    expect(snapshots[3]!.fileResults.map((file) => file.status)).toEqual(["completed", "pending"]);
    expect(snapshots[3]!.ruleResults.map((rule) => rule.status)).toEqual(["completed", "pending"]);
    expect(snapshots.every((snapshot) => snapshot.phase === "provisional")).toBe(true);
  });

  test("defaults omitted review arrays and reasons without clearing prior review states", async () => {
    const { analysis, snapshots, onWarning } = observe();
    analysis.update({
      ...update(1),
      fileResults: [{ path: "a.ts", status: "in_progress" }],
      ruleResults: [{ ruleId: "fixture/first", status: "in_progress" }],
    });
    analysis.update({
      ...update(2),
      fileResults: [{ path: "a.ts", status: "completed" }],
      ruleResults: [{ ruleId: "fixture/first", status: "pending" }],
    });
    analysis.update({
      type: "aquarius.analysis_update",
      revision: 3,
      proposedFiles: ["a.ts"],
      warnings: [warning()],
    });
    await analysis.flush();

    expect(onWarning).not.toHaveBeenCalled();
    expect(snapshots.map(({ revision }) => revision)).toEqual([0, 1, 2, 3]);
    expect(snapshots[1]!.fileResults[0]).toEqual({
      path: "a.ts",
      status: "in_progress",
      reason: "",
    });
    expect(snapshots[1]!.ruleResults[0]).toEqual({
      ruleId: "fixture/first",
      status: "in_progress",
      reason: "",
    });
    expect(snapshots[3]).toMatchObject({
      fileResults: [
        { path: "a.ts", status: "completed", reason: "" },
        { path: "b.ts", status: "pending", reason: "" },
      ],
      ruleResults: [
        { ruleId: "fixture/first", status: "pending", reason: "" },
        { ruleId: "fixture/second", status: "pending", reason: "" },
      ],
      proposedFiles: ["a.ts"],
      warnings: [warning()],
    });
  });

  test.each(["skipped", "failed"])("requires reasons on %s provisional reviews", async (status) => {
    const { analysis, snapshots, onWarning } = observe();
    analysis.update({ ...update(1), fileResults: [{ path: "a.ts", status }] });
    analysis.update({ ...update(2), ruleResults: [{ ruleId: "fixture/first", status }] });
    await analysis.flush();

    expect(snapshots).toHaveLength(1);
    expect(onWarning.mock.calls).toEqual([
      ["Ignored a provisional analysis update (INVALID_AI_ITEM): Review reason must not be empty."],
      ["Ignored a provisional analysis update (INVALID_AI_ITEM): Review reason must not be empty."],
    ]);
  });

  test("ignores older or repeated revisions without replacing the accepted state", async () => {
    const { analysis, snapshots, onWarning } = observe();
    analysis.update(update(3, { proposedFiles: ["a.ts"] }));
    analysis.update(update(2, { proposedFiles: ["b.ts"] }));
    analysis.update(update(3));
    await analysis.flush();

    expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([0, 3]);
    expect(snapshots.at(-1)!.proposedFiles).toEqual(["a.ts"]);
    expect(onWarning).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "repeated file states",
      changes: {
        fileResults: [
          { path: "b.ts", status: "completed", reason: "" },
          { path: "b.ts", status: "pending", reason: "" },
        ],
      },
    },
    {
      name: "repeated rule states",
      changes: {
        ruleResults: [
          { ruleId: "fixture/second", status: "completed", reason: "" },
          { ruleId: "fixture/second", status: "pending", reason: "" },
        ],
      },
    },
    { name: "repeated proposal paths", changes: { proposedFiles: ["a.ts", "a.ts"] } },
    {
      name: "unselected file states",
      changes: { fileResults: [{ path: "README.md", status: "completed", reason: "" }] },
    },
    {
      name: "unnormalized file states",
      changes: { fileResults: [{ path: "./a.ts", status: "completed", reason: "" }] },
    },
    {
      name: "unknown rules",
      changes: { ruleResults: [{ ruleId: "fixture/missing", status: "completed", reason: "" }] },
    },
    {
      name: "missing file skip reasons",
      changes: { fileResults: [{ path: "b.ts", status: "skipped", reason: " " }] },
    },
    {
      name: "missing file failure reasons",
      changes: { fileResults: [{ path: "b.ts", status: "failed", reason: "" }] },
    },
    {
      name: "missing rule skip reasons",
      changes: { ruleResults: [{ ruleId: "fixture/second", status: "skipped", reason: "" }] },
    },
    {
      name: "missing rule failure reasons",
      changes: { ruleResults: [{ ruleId: "fixture/second", status: "failed", reason: " " }] },
    },
    { name: "unselected proposal paths", changes: { proposedFiles: ["README.md"] } },
    { name: "new paths in file-only mode", changes: { proposedFiles: ["new.ts"] } },
    { name: "resource proposal paths", changes: { proposedFiles: ["rule-resources/first.json"] } },
    {
      name: "warnings for unknown rules",
      changes: { warnings: [{ ...warning(), ruleIds: ["fixture/missing"] }] },
    },
    {
      name: "warnings exposing resource paths",
      changes: { warnings: [warning("Resource content", ["rule-resources/first.json"])] },
    },
    {
      name: "warnings on ignored paths",
      changes: { warnings: [warning("Ignored content", ["ignored.ts"])] },
    },
  ] satisfies Array<{ name: string; changes: Partial<FormatAnalysisUpdate> }>)(
    "rejects $name atomically while allowing a corrected report",
    async ({ changes }) => {
      const { analysis, snapshots, onWarning } = observe();
      analysis.update(update(1, { proposedFiles: ["a.ts"], warnings: [warning()] }));
      await analysis.flush();
      const accepted = structuredClone(snapshots.at(-1));

      analysis.update(
        update(2, {
          fileResults: [{ path: "b.ts", status: "completed", reason: "" }],
          proposedFiles: ["b.ts"],
          ...changes,
        }),
      );
      await analysis.flush();

      expect(snapshots).toHaveLength(2);
      expect(snapshots.at(-1)).toEqual(accepted);
      expect(onWarning).toHaveBeenCalledTimes(1);

      analysis.update(update(2, { proposedFiles: ["b.ts"] }));
      await analysis.flush();
      expect(snapshots.at(-1)!.revision).toBe(2);
      expect(snapshots.at(-1)!.proposedFiles).toEqual(["b.ts"]);
    },
  );

  test.each([
    {
      name: "a proposed change on a skipped file",
      changes: {
        fileResults: [{ path: "a.ts", status: "skipped", reason: "No matching code." }],
        proposedFiles: ["a.ts"],
      },
    },
    {
      name: "a warning for a skipped rule",
      changes: {
        ruleResults: [{ ruleId: "fixture/first", status: "skipped", reason: "Not applicable." }],
        warnings: [warning()],
      },
    },
    {
      name: "proposals after every rule was skipped",
      changes: {
        ruleResults: rules.map(({ id }) => ({
          ruleId: id,
          status: "skipped" as const,
          reason: "Not applicable.",
        })),
        proposedFiles: ["a.ts"],
      },
    },
  ] satisfies Array<{ name: string; changes: Partial<FormatAnalysisUpdate> }>)(
    "rejects $name",
    async ({ changes }) => {
      const { analysis, snapshots, onWarning } = observe();
      analysis.update(update(1, changes));
      await analysis.flush();

      expect(snapshots).toHaveLength(1);
      expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("CONFLICTING_"));
    },
  );

  test("checks conflicts against retained review states from earlier updates", async () => {
    const { analysis, snapshots, onWarning } = observe();
    analysis.update(
      update(1, {
        fileResults: [{ path: "a.ts", status: "skipped", reason: "No matching code." }],
      }),
    );
    analysis.update(update(2, { proposedFiles: ["a.ts"] }));
    await analysis.flush();

    expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([0, 1]);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("CONFLICTING_FILE_RESULT"));
  });

  test("allows readable context warnings and module-scope new paths", async () => {
    const moduleRules = rules.map((rule) => ({ ...rule, scope: "module" as const }));
    const { analysis, snapshots, onWarning } = observe(moduleRules);
    analysis.update(
      update(1, {
        proposedFiles: ["new.ts"],
        warnings: [warning("The project contract needs clarification.", ["README.md"])],
      }),
    );
    await analysis.flush();

    expect(onWarning).not.toHaveBeenCalled();
    expect(snapshots.at(-1)!.proposedFiles).toEqual(["new.ts"]);
    expect(snapshots.at(-1)!.warnings[0]!.paths).toEqual(["README.md"]);
  });

  test("keeps a context warning when another file group is skipped", async () => {
    const { analysis, snapshots, onWarning } = observe();
    analysis.update(
      update(1, {
        fileResults: [{ path: "a.ts", status: "completed", reason: "" }],
        proposedFiles: ["a.ts"],
        warnings: [warning("Related code has not been reviewed.", ["b.ts"])],
      }),
    );
    analysis.update(
      update(2, {
        fileResults: [{ path: "b.ts", status: "skipped", reason: "Another file group failed." }],
        proposedFiles: ["a.ts"],
        warnings: [warning("Related code has not been reviewed.", ["b.ts"])],
      }),
    );
    await analysis.flush();

    expect(onWarning).not.toHaveBeenCalled();
    expect(snapshots.at(-1)!.fileResults[1]!.status).toBe("skipped");
    expect(snapshots.at(-1)!.warnings[0]!.paths).toEqual(["b.ts"]);
    expect(snapshots.at(-1)!.proposedFiles).toEqual(["a.ts"]);
  });

  test.each([
    { payload: null, issue: "provisional analysis update Invalid input" },
    { payload: { ...update(1), type: "other" }, issue: "type Invalid input" },
    {
      payload: { ...update(1), changes: [] },
      issue: "provisional analysis update contains unknown field(s): changes",
    },
    {
      payload: { type: "aquarius.analysis_update", revision: 1, warnings: [] },
      issue: "proposedFiles Invalid input: expected array",
    },
    { payload: { ...update(1), proposedFiles: undefined }, issue: "proposedFiles Invalid input" },
    {
      payload: { type: "aquarius.analysis_update", revision: 1, proposedFiles: [] },
      issue: "warnings Invalid input: expected array",
    },
    {
      payload: {
        ...update(1),
        fileResults: [{ path: "a.ts", status: "completed", reason: 7 }],
      },
      issue: "fileResults.0.reason Invalid input: expected string",
    },
    { payload: update(0), issue: "revision Too small" },
    { payload: update(1.5), issue: "revision Invalid input" },
  ])("reports $issue without failing finalization", async ({ payload, issue }) => {
    const { analysis, snapshots, onWarning } = observe();
    analysis.update(payload);
    await analysis.flush();
    const final = await analysis.finish(response());

    expect(onWarning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        `Ignored a provisional analysis update (INVALID_ANALYSIS_UPDATE): ${issue}`,
      ),
    );
    expect(snapshots).toHaveLength(2);
    expect(final.phase).toBe("final");
    expect(final.errors).toEqual([]);
    expect(final.proposedFiles).toEqual(["b.ts"]);
  });

  test("replaces every provisional list with the final response and blocks late callbacks", async () => {
    const { analysis, snapshots } = observe();
    analysis.update(
      update(7, {
        proposedFiles: ["a.ts"],
        warnings: [warning("Old provisional warning")],
        fileResults: [{ path: "a.ts", status: "completed", reason: "" }],
        ruleResults: [{ ruleId: "fixture/second", status: "in_progress", reason: "" }],
      }),
    );
    const finished = analysis.finish(response());
    analysis.update(update(9, { proposedFiles: ["a.ts"] }));
    const final = await finished;
    await analysis.flush();

    expect(final).toMatchObject({
      phase: "final",
      revision: 8,
      proposedFiles: ["b.ts"],
      warnings: [warning("Final warning", ["b.ts"])],
      fileResults: response().fileResults,
      ruleResults: [
        { ruleId: "fixture/first", status: "completed", reason: "" },
        { ruleId: "fixture/second", status: "skipped", reason: "No matching code." },
      ],
    });
    expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([0, 7, 8]);
  });

  test("publishes normalized partial final results as incomplete instead of retaining stale lists", async () => {
    const { analysis } = observe();
    analysis.update(update(1, { proposedFiles: ["a.ts"], warnings: [warning("Old warning")] }));
    const partial = response({
      skippedRules: [],
      errors: [{ code: "RULE_FAILED", ruleIds: ["fixture/second"], message: "Missing context." }],
      fileResults: [
        { path: "a.ts", status: "failed", reason: "Missing context." },
        { path: "b.ts", status: "completed", reason: "" },
      ],
    });
    const final = await analysis.finish(partial);

    expect(final).toMatchObject({
      phase: "incomplete",
      proposedFiles: ["b.ts"],
      warnings: partial.warnings,
      fileResults: partial.fileResults,
      errors: partial.errors,
      ruleResults: [
        { ruleId: "fixture/first", status: "completed", reason: "" },
        { ruleId: "fixture/second", status: "failed", reason: "Missing context." },
      ],
    });
  });

  test("does not mark rules complete after a global final error", async () => {
    const { analysis } = observe();
    const error = { code: "INVALID_AI_RESPONSE", ruleIds: [], message: "Invalid final response." };
    const final = await analysis.finish(response({ errors: [error], skippedRules: [] }));

    expect(final.phase).toBe("incomplete");
    expect(final.ruleResults.every((rule) => rule.status === "failed")).toBe(true);
    expect(final.ruleResults.every((rule) => rule.reason === error.message)).toBe(true);
  });

  test("keeps failed file reviews incomplete even without an error entry", async () => {
    const { analysis } = observe();
    const final = await analysis.finish(
      response({
        skippedRules: [],
        fileResults: [
          { path: "a.ts", status: "failed", reason: "Unreadable source." },
          { path: "b.ts", status: "completed", reason: "" },
        ],
      }),
    );

    expect(final.phase).toBe("incomplete");
    expect(final.ruleResults.every((rule) => rule.status === "failed")).toBe(true);
  });

  test("interrupts after queued reports and preserves the last valid provisional content", async () => {
    const { analysis, snapshots } = observe();
    analysis.update({
      type: "aquarius.analysis_update",
      revision: 3,
      proposedFiles: ["a.ts"],
      warnings: [warning()],
      fileResults: [{ path: "a.ts", status: "in_progress" }],
    });
    const errors = [{ code: "AI_TIMEOUT", ruleIds: [], message: "Request timed out." }];
    const interrupted = analysis.interrupt(errors);
    analysis.update(update(5, { proposedFiles: ["b.ts"] }));
    const final = await interrupted;
    await analysis.flush();

    expect(final).toMatchObject({
      phase: "incomplete",
      revision: 4,
      proposedFiles: ["a.ts"],
      warnings: [warning()],
      errors,
    });
    expect(final.fileResults.map((file) => file.status)).toEqual(["in_progress", "pending"]);
    expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([0, 3, 4]);
  });

  test("isolates callback mutations and returned snapshots from the internal state", async () => {
    const analysis = createFormatAnalysis(rules, policy, resources, {
      onUpdate: (snapshot) => {
        (snapshot.fileResults as FileReview[])[0]!.status = "failed";
        (snapshot.proposedFiles as string[]).push("injected.ts");
        if (snapshot.warnings[0]) {
          snapshot.warnings[0].message = "Injected warning";
        }
      },
    });
    analysis.update(update(1, { proposedFiles: ["a.ts"], warnings: [warning()] }));
    const interrupted = await analysis.interrupt();

    expect(interrupted.fileResults[0]!.status).toBe("pending");
    expect(interrupted.proposedFiles).toEqual(["a.ts"]);
    expect(interrupted.warnings[0]!.message).toBe(warning().message);

    (interrupted.proposedFiles as string[]).push("changed-return-value.ts");
    const later = await analysis.interrupt();
    expect(later.proposedFiles).toEqual(["a.ts"]);
  });

  test.each(["sync", "async"] as const)(
    "contains %s observer failures without rejecting updates or finalization",
    async (kind) => {
      const onWarning = vi.fn();
      const analysis = createFormatAnalysis(rules, policy, resources, {
        onUpdate: () => {
          if (kind === "sync") {
            throw new Error("Observer failed.");
          }
          return Promise.reject(new Error("Observer failed."));
        },
        onWarning,
      });
      analysis.update(update(1, { proposedFiles: ["a.ts"] }));
      await analysis.flush();
      const final = await analysis.finish(response());
      await Promise.resolve();

      expect(final.phase).toBe("final");
      expect(final.proposedFiles).toEqual(["b.ts"]);
      expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("observer failed"));
    },
  );

  test.each(["sync", "async"] as const)("contains %s warning observer failures", async (kind) => {
    const analysis = createFormatAnalysis(rules, policy, resources, {
      onWarning: () => {
        if (kind === "sync") {
          throw new Error("Warning observer failed.");
        }
        return Promise.reject(new Error("Warning observer failed."));
      },
    });
    analysis.update({ invalid: true });
    analysis.update(update(1, { proposedFiles: ["a.ts"] }));
    await analysis.flush();

    await expect(analysis.finish(response())).resolves.toMatchObject({
      phase: "final",
      proposedFiles: ["b.ts"],
    });
  });
});
