import { describe, expect, test } from "vitest";
import { allRulesPreset } from "../src/presets";
import { prepareRules } from "../../core/src/rules/prepare";
import type { LoadedConfig } from "../../core/src/config/types";
import { section02Rules } from "../src/lint/section-02";

const rules = section02Rules;
const ids = [
  "module/explicit-public-api",
  "module/no-private-type-leak",
  "module/cohesive-package-contents",
  "module/no-miscellaneous-dump",
  "module/explicit-import-side-effects",
  "module/lightweight-initialization",
  "module/stable-package-entrypoints",
  "module/no-runtime-dependency-on-tests",
  "module/declare-direct-dependencies",
  "module/separate-generated-code",
  "module/no-server-code-in-client-bundle",
  "module/no-source-build-output-mixing",
  "module/semantic-module-names",
  "module/no-ambiguous-reexports",
  "module/consistent-import-identity",
];

const config = (selected: LoadedConfig["rules"]): LoadedConfig => ({
  tool: "lint",
  cwd: process.cwd(),
  projectRoot: process.cwd(),
  configDirectory: process.cwd(),
  files: [],
  ignore: [],
  plugins: ["section"],
  ai: { adapter: "codex", options: {}, timeoutMs: 30_000 },
  preset: [],
  rules: selected,
});
const plugins = { section: { namespace: "aquarius", lintRules: rules } };

describe("section 02 rule definitions", () => {
  test("preserves the canonical independent IDs and report-only defaults", () => {
    expect(rules.map((rule) => rule.id)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => allRulesPreset[`aquarius/${id}`] === "warn")).toBe(true);
  });

  test("prepares every rule through the existing engine API", async () => {
    const selections = Object.fromEntries(
      ids.map((id) => [`aquarius/${id}`, allRulesPreset[`aquarius/${id}`]]),
    );
    const prepared = await prepareRules(config(selections), plugins);
    expect(prepared.errors).toEqual([]);
    expect(prepared.rules.map((rule) => rule.id)).toEqual(ids.map((id) => `aquarius/${id}`));
    for (const rule of rules) {
      const prompt = await rule.buildPrompt({ options: {} });
      expect(prompt.criteria).toContain(rule.description);
      expect(prompt.applicability).not.toBe("");
      expect(prompt.evidenceRequirements.length).toBeGreaterThanOrEqual(2);
      expect(prompt.exceptions?.length).toBeGreaterThan(0);
      expect(prompt.procedure?.join(" ")).toContain("비활성화");
      expect(prompt.examples?.some((example) => example.expected === "pass")).toBe(true);
      expect(prompt.examples?.map((example) => example.expected)).not.toContain("unknown");
      expect(prompt.criteria).toContain("보고 전용");
    }
  });

  test("registration leaves rules inactive and off disables only the selected rule", async () => {
    expect(await prepareRules(config({}), plugins)).toEqual({ rules: [], errors: [] });
    const selections = Object.fromEntries(
      ids.map((id) => [`aquarius/${id}`, allRulesPreset[`aquarius/${id}`]]),
    );
    const active = await prepareRules(config(selections), plugins);
    expect(active.errors).toEqual([]);
    expect(active.rules.map(({ id }) => id)).toEqual(ids.map((id) => `aquarius/${id}`));

    for (const disabled of ids) {
      const withOff = await prepareRules(
        config({ ...selections, [`aquarius/${disabled}`]: "off" }),
        plugins,
      );
      expect(withOff.errors).toEqual([]);
      expect(withOff.rules).toEqual(active.rules.filter(({ id }) => id !== `aquarius/${disabled}`));
    }
  });

  test("rejects invented options without dropping other selected rules", async () => {
    const prepared = await prepareRules(
      config({
        [`aquarius/${ids[0]}`]: ["warn", { invented: true }],
        [`aquarius/${ids[1]}`]: "warn",
      }),
      plugins,
    );
    expect(prepared.errors.map((error) => error.code)).toEqual(["RULE_OPTIONS_INVALID"]);
    expect(prepared.rules.map((rule) => rule.id)).toEqual([`aquarius/${ids[1]}`]);
  });

  test("returns independent prompt objects without changing caller options", async () => {
    for (const rule of rules) {
      const options = Object.freeze({});
      const first = await rule.buildPrompt({ options });
      first.evidenceRequirements.push("mutated by caller");
      first.exceptions?.push("unapproved exception");
      const second = await rule.buildPrompt({ options });
      expect(second.evidenceRequirements).not.toContain("mutated by caller");
      expect(second.exceptions).not.toContain("unapproved exception");
      expect(options).toEqual({});
    }
  });
});

describe("section 02 semantic boundaries", () => {
  test("module/explicit-public-api", async () => {
    const rule = rules.find((candidate) => candidate.id === "module/explicit-public-api")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("exports");
    expect(text).toContain("보안 격리");
    expect(text).toContain("소비자");
  });

  test("module/no-private-type-leak", async () => {
    const rule = rules.find((candidate) => candidate.id === "module/no-private-type-leak")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("JavaScript");
    expect(text).toContain("타입·선언 파일");
    expect(text).toContain("반환 객체");
    expect(text).toContain("vendor");
  });

  test("module/no-miscellaneous-dump", async () => {
    const rule = rules.find((candidate) => candidate.id === "module/no-miscellaneous-dump")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("독립");
    expect(text).toContain("cohesive-package-contents");
    expect(text).toContain("비활성화");
  });

  test("module/explicit-import-side-effects", async () => {
    const rule = rules.find((candidate) => candidate.id === "module/explicit-import-side-effects")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("module.sideEffects");
    expect(text).toContain("폴리필");
    expect(text).toContain("순서");
  });

  test("module/declare-direct-dependencies", async () => {
    const rule = rules.find((candidate) => candidate.id === "module/declare-direct-dependencies")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("peer");
    expect(text).toContain("optional");
    expect(text).toContain("host");
    expect(text).toContain("패키지 매니저");
  });

  test("module/no-server-code-in-client-bundle", async () => {
    const rule = rules.find(
      (candidate) => candidate.id === "module/no-server-code-in-client-bundle",
    )!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("실제 client bundle");
    expect(text).toContain("소스 import만으로");
  });

  test("module/consistent-import-identity", async () => {
    const rule = rules.find((candidate) => candidate.id === "module/consistent-import-identity")!;
    const prompt = await rule.buildPrompt({ options: {} });
    const text = JSON.stringify(prompt);
    expect(text).toContain("CommonJS");
    expect(text).toContain("ESM URL");
    expect(text).toContain("조건부 exports");
    expect(text).toContain("worker");
    expect(text).toContain("실제 해석");
  });
});
