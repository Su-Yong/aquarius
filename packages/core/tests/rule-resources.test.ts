import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { prepareRuleResources } from "../src/ai/rule-resources";
import type { PreparedRuleResources } from "../src/ai/types";
import type { PreparedRule } from "../src/rules/types";

vi.mock("node:fs/promises", async (importOriginal) => {
  return { ...(await importOriginal<typeof import("node:fs/promises")>()) };
});

const projects: string[] = [];
const preparedRuns: PreparedRuleResources[] = [];

const createProject = async (withNodeModules = false): Promise<string> => {
  const directory = await fs.mkdtemp(join(tmpdir(), "aquarius-resource-test-"));
  projects.push(directory);
  const root = await fs.realpath(directory);
  if (withNodeModules) {
    await fs.mkdir(join(root, "node_modules"));
  }
  return root;
};

const lintRule = (
  criteria = "Report mutations of borrowed input.",
  id = "test/no-mutation",
): PreparedRule => ({
  id,
  scope: "module",
  severity: "error",
  instructions: {
    applicability: "An input is borrowed or immutable.",
    criteria,
    evidenceRequirements: ["The contract.", "The mutation."],
    exceptions: ["Exclusive ownership permits mutation."],
    procedure: ["Inspect the caller and aliases."],
    examples: [
      {
        scenario: "A borrowed array is sorted in place.",
        expected: "violation",
        reason: "Sorting mutates the input.",
      },
    ],
  },
});

const prepare = async (
  root: string,
  rules: PreparedRule[] = [lintRule()],
  onWarning?: (message: string) => void,
): Promise<PreparedRuleResources> => {
  const prepared = await prepareRuleResources({
    projectRoot: root,
    tool: "lint",
    rules,
    onWarning,
  });
  preparedRuns.push(prepared);
  return prepared;
};

const detailPath = (prepared: PreparedRuleResources, index = 0): string => {
  return join(prepared.resources.directory, prepared.resources.files[index]!.detailsPath);
};

const cachePath = (root: string, prepared: PreparedRuleResources, index = 0): string => {
  return join(root, "node_modules", ".cache", "aquarius", basename(detailPath(prepared, index)));
};

const captureRunDirectories = (): string[] => {
  const created: string[] = [];
  const original = fs.mkdtemp;
  vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args: Parameters<typeof fs.mkdtemp>) => {
    const directory = await original(...args);
    if (typeof directory === "string" && directory.includes("aquarius-rule-resources-")) {
      created.push(directory);
    }
    return directory;
  });
  return created;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(preparedRuns.splice(0).map((prepared) => prepared.dispose()));
  await Promise.all(
    projects.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("rule resources", () => {
  test("preserves full instructions and supplies readable, hashed references in rule order", async () => {
    const root = await createProject();
    const rules = [lintRule(), lintRule("Check a second obligation.", "test/second")];
    const prepared = await prepare(root, rules);

    expect(prepared.resources.files.map((file) => file.ruleId)).toEqual(
      rules.map((rule) => rule.id),
    );
    for (const [index, rule] of rules.entries()) {
      const file = prepared.resources.files[index]!;
      const bytes = await fs.readFile(detailPath(prepared, index));
      expect(file.detailsPath).toMatch(
        /^\.aquarius-rules-[A-Za-z0-9_-]+\/lint-[a-f0-9]{64}\.json$/,
      );
      expect(file.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(file.applicability).toBe(rule.instructions.applicability);
      expect(JSON.parse(bytes.toString())).toEqual({
        ruleId: rule.id,
        scope: rule.scope,
        instructions: rule.instructions,
      });
      expect(bytes.toString()).not.toContain(prepared.resources.directory);
      expect(Object.keys(file)).not.toContain("instructions");
    }
  });

  test("does not create node_modules or search a parent's installation", async () => {
    const parent = await createProject(true);
    const root = join(parent, "project");
    await fs.mkdir(root);
    const warnings = vi.fn();
    const prepared = await prepare(root, [lintRule()], warnings);

    await expect(fs.readFile(detailPath(prepared), "utf8")).resolves.toContain("Report mutations");
    await expect(fs.lstat(join(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(join(parent, "node_modules", ".cache"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(warnings).not.toHaveBeenCalled();
  });

  test("reuses identical cache bytes without rewriting the file or sharing its inode", async () => {
    const root = await createProject(true);
    const first = await prepare(root);
    const cached = cachePath(root, first);
    const oldDate = new Date("2020-01-01T00:00:00Z");
    await fs.utimes(cached, oldDate, oldDate);
    const before = await fs.stat(cached, { bigint: true });
    const second = await prepare(root);
    const after = await fs.stat(cached, { bigint: true });

    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ino).toBe(before.ino);
    expect(await fs.readFile(detailPath(second))).toEqual(await fs.readFile(cached));
    expect((await fs.stat(detailPath(second), { bigint: true })).ino).not.toBe(after.ino);
    expect(second.resources.directory).not.toBe(first.resources.directory);
  });

  test("keeps only the latest contents and isolates prepared runs from cache replacement and deletion", async () => {
    const root = await createProject(true);
    const first = await prepare(root, [lintRule("First effective option.")]);
    const second = await prepare(root, [lintRule("Second effective option.")]);
    const cached = cachePath(root, first);

    expect(cachePath(root, second)).toBe(cached);
    expect(await fs.readdir(join(root, "node_modules", ".cache", "aquarius"))).toEqual([
      basename(cached),
    ]);
    expect(await fs.readFile(cached, "utf8")).toContain("Second effective option.");
    expect(await fs.readFile(detailPath(first), "utf8")).toContain("First effective option.");
    await fs.rm(join(root, "node_modules"), { recursive: true });
    expect(await fs.readFile(detailPath(second), "utf8")).toContain("Second effective option.");
  });

  test("separates lint and format cache entries even when rule IDs match", async () => {
    const root = await createProject(true);
    const lint = await prepare(root);
    const rule: PreparedRule = {
      id: "test/no-mutation",
      scope: "file",
      instructions: {
        applicability: "Nested branches are present.",
        transformation: "Use equivalent early returns.",
        constraints: ["Preserve behavior."],
      },
    };
    const format = await prepareRuleResources({ projectRoot: root, tool: "format", rules: [rule] });
    preparedRuns.push(format);

    expect(cachePath(root, format)).not.toBe(cachePath(root, lint));
    expect(JSON.parse(await fs.readFile(detailPath(format), "utf8")).instructions).toEqual(
      rule.instructions,
    );
    expect(await fs.readdir(join(root, "node_modules", ".cache", "aquarius"))).toHaveLength(2);
  });

  test("rebuilds corrupt cache content and reports a nonfatal warning", async () => {
    const root = await createProject(true);
    const first = await prepare(root);
    const cached = cachePath(root, first);
    await fs.writeFile(cached, "not JSON");
    const warnings = vi.fn();
    const second = await prepare(root, [lintRule()], warnings);

    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("Rule cache is invalid"));
    expect(await fs.readFile(cached)).toEqual(await fs.readFile(detailPath(second)));
    expect(JSON.parse(await fs.readFile(detailPath(second), "utf8")).ruleId).toBe(
      "test/no-mutation",
    );
  });

  test.each(["node_modules", "node_modules/.cache", "node_modules/.cache/aquarius"])(
    "does not follow a symlink at %s",
    async (relativePath) => {
      const root = await createProject();
      const outside = await createProject();
      const parent = relativePath.split("/").slice(0, -1).join("/");
      if (parent) {
        await fs.mkdir(join(root, parent), { recursive: true });
      }
      await fs.writeFile(join(outside, "sentinel"), "unchanged");
      await fs.symlink(outside, join(root, relativePath), "dir");
      const warnings = vi.fn();
      const prepared = await prepare(root, [lintRule()], warnings);

      expect(warnings).toHaveBeenCalled();
      expect(await fs.readdir(outside)).toEqual(["sentinel"]);
      expect(await fs.readFile(detailPath(prepared), "utf8")).toContain("Report mutations");
    },
  );

  test("does not overwrite a cache entry symlink", async () => {
    const root = await createProject(true);
    const outside = await createProject();
    const first = await prepare(root);
    const cached = cachePath(root, first);
    const target = join(outside, "sentinel.json");
    await fs.writeFile(target, "unchanged");
    await fs.rm(cached);
    await fs.symlink(target, cached);
    const warnings = vi.fn();
    const second = await prepare(root, [lintRule()], warnings);

    expect(warnings).toHaveBeenCalled();
    expect(await fs.readFile(target, "utf8")).toBe("unchanged");
    expect((await fs.lstat(cached)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(detailPath(second), "utf8")).toContain("Report mutations");
  });

  test("continues with temporary resources when the cache directory is an ordinary file", async () => {
    const root = await createProject(true);
    await fs.writeFile(join(root, "node_modules", ".cache"), "preserve me");
    const warnings = vi.fn();
    const prepared = await prepare(root, [lintRule()], warnings);

    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("Rule cache is unavailable"));
    expect(await fs.readFile(join(root, "node_modules", ".cache"), "utf8")).toBe("preserve me");
    expect(await fs.readFile(detailPath(prepared), "utf8")).toContain("Report mutations");
  });

  test("cleans an unsuccessful atomic cache write and falls back without changing the rule", async () => {
    const root = await createProject(true);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
    const warnings = vi.fn();
    const prepared = await prepare(root, [lintRule()], warnings);

    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("Rule cache could not be used"));
    expect(await fs.readdir(join(root, "node_modules", ".cache", "aquarius"))).toEqual([]);
    expect(await fs.readFile(detailPath(prepared), "utf8")).toContain("Report mutations");
  });

  test("concurrent preparations never mix rule contents", async () => {
    const root = await createProject(true);
    const runs = await Promise.all([
      prepare(root, [lintRule("Option A.")]),
      prepare(root, [lintRule("Option B.")]),
      prepare(root, [lintRule("Option C.")]),
    ]);

    for (const [index, expected] of ["Option A.", "Option B.", "Option C."].entries()) {
      expect(
        JSON.parse(await fs.readFile(detailPath(runs[index]!), "utf8")).instructions.criteria,
      ).toBe(expected);
    }
    const cachedFiles = await fs.readdir(join(root, "node_modules", ".cache", "aquarius"));
    expect(cachedFiles).toHaveLength(1);
    expect(cachedFiles[0]).toMatch(/^lint-[a-f0-9]{64}\.json$/);
  });

  test("rejects invalid and duplicate rules before creating run resources", async () => {
    const root = await createProject();
    const created = captureRunDirectories();
    const invalid = lintRule();
    invalid.instructions.applicability = " ";

    await expect(prepare(root, [invalid])).rejects.toMatchObject({ code: "INVALID_RULE_RESOURCE" });
    await expect(prepare(root, [lintRule(), lintRule()])).rejects.toMatchObject({
      code: "INVALID_RULE_RESOURCE",
    });
    expect(created).toEqual([]);
  });

  test("rejects an already cancelled preparation without creating directories", async () => {
    const root = await createProject();
    const created = captureRunDirectories();
    await expect(
      prepareRuleResources({
        projectRoot: root,
        tool: "lint",
        rules: [lintRule()],
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: "AI_ABORTED" });
    expect(created).toEqual([]);
  });

  test("removes prepared files when cancellation happens during setup", async () => {
    const root = await createProject(true);
    await fs.writeFile(join(root, "node_modules", ".cache"), "blocked cache");
    const created = captureRunDirectories();
    const controller = new AbortController();

    await expect(
      prepareRuleResources({
        projectRoot: root,
        tool: "lint",
        rules: [lintRule()],
        signal: controller.signal,
        onWarning: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ code: "AI_ABORTED" });
    expect(created).toHaveLength(1);
    await expect(fs.lstat(created[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("cleans the run directory and rejects when temporary resources cannot be written", async () => {
    const root = await createProject();
    const created = captureRunDirectories();
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(
      Object.assign(new Error("disk full"), { code: "ENOSPC" }),
    );

    await expect(prepare(root)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(created).toHaveLength(1);
    await expect(fs.lstat(created[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("disposes only its own run and can be disposed twice", async () => {
    const root = await createProject();
    const first = await prepare(root);
    const second = await prepare(root);
    const firstDirectory = first.resources.directory;
    first.resources.directory = root;

    await first.dispose();
    await first.dispose();
    await expect(fs.lstat(firstDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(root)).resolves.toBeDefined();
    await expect(fs.readFile(detailPath(second), "utf8")).resolves.toContain("Report mutations");
  });

  test("does not remove a replacement directory during disposal", async () => {
    const root = await createProject();
    const warnings = vi.fn();
    const prepared = await prepare(root, [lintRule()], warnings);
    const originalPath = prepared.resources.directory;
    await fs.rename(originalPath, join(root, "moved-resources"));
    await fs.mkdir(originalPath);
    projects.push(originalPath);
    await fs.writeFile(join(originalPath, "sentinel"), "another owner");

    await prepared.dispose();

    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("refusing to remove"));
    expect(await fs.readFile(join(originalPath, "sentinel"), "utf8")).toBe("another owner");
  });
});
