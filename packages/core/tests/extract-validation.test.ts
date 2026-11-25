import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { normalizeConfig } from "../src/config/load";
import type { ExtractionVerdict } from "../src/extract/schemas";
import { validateAndRepairVerdicts } from "../src/extract/validate-repair";
import { prepareRules } from "../src/rules/prepare";
import type { FormatRule, RulePlugin } from "../src/rules/types";
import type { RunError } from "../src/shared/types";

describe("config extraction verdict validation", () => {
  test("repairs invalid settings once and retains the valid rules and findings", async () => {
    const fixture = context();
    const repair = vi.fn(async (_issues: RunError[]) => [
      observed("fixed", { width: 80 }),
      observed("unchanged", { width: 123 }),
      observed("failed", { width: "invalid after repair" }),
      observed("duplicate", { width: 100 }),
    ]);
    const insufficient: ExtractionVerdict = {
      ...observed("uncertain", null),
      status: "insufficient_evidence",
    };

    const result = await validateAndRepairVerdicts({
      ...fixture,
      verdicts: [
        observed("unchanged", { width: 120 }),
        observed("fixed", { typo: true }),
        observed("failed", { width: "invalid" }),
        observed("duplicate", { width: 101 }),
        observed("duplicate", { width: 102 }),
        observed("unknown", false),
        insufficient,
      ],
      repair,
    });

    expect(repair).toHaveBeenCalledOnce();
    const issues = repair.mock.calls[0]![0];
    expect(issues.map(({ ruleIds }) => ruleIds[0]).sort()).toEqual([
      "demo/duplicate",
      "demo/failed",
      "demo/fixed",
    ]);
    expect(issues.find(({ ruleIds }) => ruleIds[0] === "demo/fixed")?.message).toContain("typo");
    expect(result.rules).toEqual({
      "demo/unchanged": { width: 120 },
      "demo/fixed": { width: 80 },
      "demo/duplicate": { width: 100 },
    });
    expect(result.findings.map(({ ruleId }) => ruleId)).toEqual([
      "demo/unchanged",
      "demo/fixed",
      "demo/duplicate",
      "demo/uncertain",
    ]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "RULE_OPTIONS_INVALID", ruleIds: ["demo/failed"] }),
        expect.objectContaining({ code: "EXTRACTION_VERDICT_INVALID", ruleIds: ["demo/unknown"] }),
      ]),
    );
    const prepared = await prepareRules(
      { ...fixture.config, rules: result.rules },
      fixture.plugins,
    );
    expect(prepared.errors).toEqual([]);
    expect(prepared.rules).toHaveLength(3);
  });

  test("warns about unknown rule IDs without requesting repair", async () => {
    const repair = vi.fn(async () => []);
    const result = await validateAndRepairVerdicts({
      ...context(),
      verdicts: [observed("unknown", true)],
      repair,
    });

    expect(repair).not.toHaveBeenCalled();
    expect(result).toEqual({
      rules: {},
      findings: [],
      warnings: [
        expect.objectContaining({
          code: "EXTRACTION_VERDICT_INVALID",
          ruleIds: ["demo/unknown"],
        }),
      ],
    });
  });

  test("allows repair of malformed settings and instruction generation failures", async () => {
    const repair = vi.fn(async () => [
      observed("fixed", { width: 88 }),
      observed("prompt", { width: 88 }),
      { ...observed("uncertain", null), status: "insufficient_evidence" as const },
    ]);
    const result = await validateAndRepairVerdicts({
      ...context(),
      verdicts: [
        observed("fixed", "warn"),
        observed("prompt", { width: 1 }),
        { ...observed("uncertain", true), status: "insufficient_evidence" },
      ],
      repair,
    });

    expect(repair).toHaveBeenCalledWith([
      expect.objectContaining({ code: "CONFIG_INVALID", ruleIds: ["demo/fixed"] }),
      expect.objectContaining({ code: "EXTRACTION_VERDICT_INVALID", ruleIds: ["demo/uncertain"] }),
      expect.objectContaining({
        code: "RULE_PROMPT_FAILED",
        ruleIds: ["demo/prompt"],
        message: expect.stringContaining("Cannot build prompt"),
      }),
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.rules).toEqual({
      "demo/fixed": { width: 88 },
      "demo/prompt": { width: 88 },
    });
    expect(result.findings.find(({ ruleId }) => ruleId === "demo/uncertain")?.setting).toBeNull();
  });

  test("keeps valid findings if repair fails and propagates cancellation", async () => {
    const options = {
      ...context(),
      verdicts: [observed("unchanged", { width: 100 }), observed("fixed", undefined)],
    };
    const result = await validateAndRepairVerdicts({
      ...options,
      repair: async () => {
        throw new Error("Adapter unavailable");
      },
    });
    expect(result.rules).toEqual({ "demo/unchanged": { width: 100 } });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        ruleIds: ["demo/fixed"],
        message: expect.stringContaining("Adapter unavailable"),
      }),
    ]);

    const abort = new AbortController();
    await expect(
      validateAndRepairVerdicts({
        ...options,
        signal: abort.signal,
        repair: async () => {
          abort.abort();
          return [observed("fixed", { width: 100 })];
        },
      }),
    ).rejects.toMatchObject({ code: "AI_ABORTED" });
  });
});

const context = () => {
  const formatRules: FormatRule[] = [
    "fixed",
    "failed",
    "duplicate",
    "unchanged",
    "uncertain",
    "prompt",
  ].map((id) => ({
    id,
    description: "Control width",
    scope: "file",
    optionsSchema: z.strictObject({ width: z.number() }),
    buildPrompt: ({ options }) => {
      if (id === "prompt" && options.width === 1) throw new Error("Cannot build prompt");
      return { applicability: "Source files", transformation: "Reflow lines", constraints: [] };
    },
  }));
  const plugin: RulePlugin = { namespace: "demo", formatRules };
  return {
    config: normalizeConfig("format", process.cwd(), { plugins: ["plugin"] }),
    plugins: { plugin },
    candidates: new Map(formatRules.map((rule) => [`demo/${rule.id}`, rule])),
  };
};

const observed = (id: string, setting: unknown): ExtractionVerdict => ({
  ruleId: `demo/${id}`,
  status: "observed",
  setting,
  reason: "Observed pattern",
  mixed: false,
  observations: null,
});
