import { setImmediate } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { validateConfig } from "../config/load";
import type { LoadedConfig } from "../config/types";
import {
  deepMerge,
  loadRulePlugins,
  prepareRuleInstructions,
  prepareRules,
  resolveRuleSetting,
} from "../rules/prepare";
import { formatRuleSettingSchema, lintRuleSettingSchema } from "../rules/schemas";
import type { FormatRule, LintRule, RulePlugin, RuleSetting, RuleSettings } from "../rules/types";
import { AquariusError } from "../shared/errors";
import { isPlainObject } from "../shared/json";
import type { JsonObject } from "../shared/types";

const MAX_SEARCH_STATES = 2_048;
const SEARCH_YIELD_INTERVAL = 256;

type Selection = ReturnType<typeof resolveRuleSetting>;
type Instructions = Awaited<ReturnType<typeof prepareRuleInstructions>>;
type CompareInstructions = (
  ruleId: string,
  left: JsonObject,
  right: JsonObject,
) => Promise<boolean>;

interface Preset {
  reference: string;
  selections: Map<string, Selection>;
}

interface PresetGroup {
  presets: Preset[];
  ruleIds: Set<string>;
}

interface CompressionOptions {
  config: LoadedConfig;
  plugins: Record<string, RulePlugin>;
  candidates: ReadonlyMap<string, LintRule | FormatRule>;
  rules: RuleSettings;
  insufficient: ReadonlySet<string>;
  excluded?: ReadonlySet<string>;
  signal?: AbortSignal;
}

interface CompressedRules {
  preset: string[];
  rules: RuleSettings;
}

interface PresetPlan {
  preset: string[];
  overrides: Map<string, RuleSetting>;
}

export const compressPresets = async (options: CompressionOptions): Promise<CompressedRules> => {
  const { config, plugins, rules, signal } = options;
  const registry = await loadRulePlugins(config, plugins);
  const { errors, lintRules, formatRules } = registry;
  if (errors.length > 0) throw new AquariusError(errors[0]!.code, errors[0]!.message);

  const available = readPresets(config, registry.plugins.values(), lintRules, formatRules);
  const overrides = new Map(Object.entries(rules));
  const preset: string[] = [];
  const instructionsMatch = compareRuleInstructions(options);

  for (const group of groupPresets(available)) {
    const desired = new Map(Object.entries(rules).filter(([id]) => group.ruleIds.has(id)));
    if (desired.size < 2) continue;

    const best = await bestGroupPlan(options, group.presets, desired, instructionsMatch);
    preset.push(...best.preset);
    for (const id of desired.keys()) overrides.delete(id);
    for (const [id, setting] of best.overrides) overrides.set(id, setting);
  }

  assertActive(signal);
  const result = { preset, rules: Object.fromEntries(overrides) };
  validateConfig(config.tool, result);
  const prepared = await prepareRules({ ...config, ...result }, plugins);
  if (prepared.errors.length > 0) {
    const error = prepared.errors[0]!;
    throw new AquariusError(error.code, error.message);
  }
  assertActive(signal);
  return result;
};

const readPresets = (
  config: LoadedConfig,
  plugins: Iterable<RulePlugin>,
  lintRules: ReadonlyMap<string, LintRule>,
  formatRules: ReadonlyMap<string, FormatRule>,
): Preset[] => {
  const available: Preset[] = [];

  for (const plugin of plugins) {
    for (const [name, settings] of Object.entries(plugin.presets ?? {})) {
      const reference = `${plugin.namespace}/${name}`;
      if (!isPlainObject(settings)) continue;
      try {
        validateConfig(config.tool, { preset: [reference] });
      } catch {
        continue;
      }

      const selections = new Map<string, Selection>();
      let valid = true;
      for (const [id, setting] of Object.entries(settings)) {
        const kind = lintRules.has(id) ? "lint" : formatRules.has(id) ? "format" : undefined;
        const schema = kind === "lint" ? lintRuleSettingSchema : formatRuleSettingSchema;
        const parsed = schema.safeParse(setting);
        if (kind === undefined || !parsed.success) {
          valid = false;
          break;
        }
        if (kind === config.tool) selections.set(id, resolveRuleSetting(parsed.data));
      }
      if (valid && selections.size > 0) available.push({ reference, selections });
    }
  }

  return available.sort(byReference);
};

const groupPresets = (presets: Preset[]): PresetGroup[] => {
  // Presets that affect disjoint rules can be optimized independently.
  const groups: PresetGroup[] = [];
  for (const preset of presets) {
    const ruleIds = [...preset.selections.keys()];
    const group: PresetGroup = {
      presets: [preset],
      ruleIds: new Set(ruleIds),
    };

    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const previous = groups[index]!;
      if (!ruleIds.some((id) => previous.ruleIds.has(id))) continue;

      group.presets.push(...previous.presets);
      for (const id of previous.ruleIds) group.ruleIds.add(id);
      groups.splice(index, 1);
    }
    group.presets.sort(byReference);
    groups.push(group);
  }
  return groups.sort((left, right) => byReference(left.presets[0]!, right.presets[0]!));
};

const bestGroupPlan = async (
  options: CompressionOptions,
  presets: Preset[],
  desired: Map<string, RuleSetting>,
  instructionsMatch: CompareInstructions,
): Promise<PresetPlan> => {
  let best: PresetPlan = { preset: [], overrides: desired };
  const visited = new Set<string>();
  let states = 0;

  const visit = async (
    selected: string[],
    remaining: Preset[],
    effective: Map<string, Selection>,
  ): Promise<void> => {
    states += 1;
    if (states % SEARCH_YIELD_INTERVAL === 0) await setImmediate();
    assertActive(options.signal);

    const key = stateKey(remaining, effective);
    if (visited.has(key)) return;
    visited.add(key);

    const overrides = await buildOverrides(options, desired, effective, instructionsMatch);
    if (overrides) {
      const plan = { preset: selected, overrides };
      if (isBetter(plan, best) && (await isValidPlan(options, plan))) best = plan;
    }
    // Each additional preset costs one entry before counting any overrides.
    if (selected.length + 1 >= planCost(best)) return;

    for (const [index, preset] of remaining.entries()) {
      if (states >= MAX_SEARCH_STATES) break;

      const merged = new Map(effective);
      for (const [id, setting] of preset.selections) {
        const defaults = merged.get(id);
        merged.set(id, {
          ...setting,
          options: deepMerge(defaults?.options ?? {}, setting.options),
        });
      }
      if (isDeepStrictEqual(merged, effective)) continue;

      const remainingPresets = remaining.filter((_, itemIndex) => itemIndex !== index);
      await visit([...selected, preset.reference], remainingPresets, merged);
    }
  };

  await visit([], presets, new Map());
  return best;
};

const buildOverrides = async (
  { config, candidates, excluded, insufficient }: CompressionOptions,
  desired: ReadonlyMap<string, RuleSetting>,
  effective: ReadonlyMap<string, Selection>,
  instructionsMatch: CompareInstructions,
): Promise<Map<string, RuleSetting> | undefined> => {
  const overrides = new Map<string, RuleSetting>();
  for (const [id, setting] of desired) {
    const current = effective.get(id);
    const target = resolveRuleSetting(setting);
    if (current) {
      const sameSetting =
        current.enabled === target.enabled &&
        (!target.enabled ||
          (current.severity === target.severity &&
            (await instructionsMatch(id, current.options, target.options))));
      if (sameSetting) continue;

      // An override inherits preset options, so it must preserve the observed instructions.
      if (
        target.enabled &&
        !(await instructionsMatch(id, deepMerge(current.options, target.options), target.options))
      ) {
        return undefined;
      }
    }
    overrides.set(id, setting);
  }

  for (const [id, setting] of effective) {
    if (!setting.enabled || desired.has(id)) continue;
    if (!candidates.has(id) || excluded?.has(id)) return undefined;
    if (!insufficient.has(id)) overrides.set(id, config.tool === "lint" ? "off" : false);
  }

  return overrides;
};

const compareRuleInstructions = ({
  config,
  candidates,
}: CompressionOptions): CompareInstructions => {
  const cache = new Map<string, Promise<Instructions | undefined>>();

  const instructionsFor = (ruleId: string, options: JsonObject, serialized: string) => {
    const rule = candidates.get(ruleId);
    if (!rule) return undefined;

    const key = `${ruleId}:${serialized}`;
    let instructions = cache.get(key);
    if (!instructions) {
      instructions = prepareRuleInstructions(config.tool, rule, deepMerge({}, options)).catch(
        () => undefined,
      );
      cache.set(key, instructions);
    }
    return instructions;
  };

  return async (ruleId, left, right) => {
    const leftKey = JSON.stringify(left);
    const rightKey = JSON.stringify(right);
    if (leftKey === rightKey) return true;

    const leftInstructions = await instructionsFor(ruleId, left, leftKey);
    const rightInstructions = await instructionsFor(ruleId, right, rightKey);
    return (
      leftInstructions !== undefined &&
      rightInstructions !== undefined &&
      isDeepStrictEqual(leftInstructions, rightInstructions)
    );
  };
};

const isValidPlan = async (
  { config, plugins }: CompressionOptions,
  { preset, overrides }: PresetPlan,
): Promise<boolean> => {
  const { errors } = await prepareRules(
    { ...config, preset, rules: Object.fromEntries(overrides) },
    plugins,
  );
  return errors.length === 0;
};

const planCost = ({ preset, overrides }: PresetPlan): number => preset.length + overrides.size;

const isBetter = (plan: PresetPlan, best: PresetPlan): boolean =>
  planCost(plan) < planCost(best) ||
  (planCost(plan) === planCost(best) && plan.preset.length < best.preset.length);

const stateKey = (
  remaining: readonly Preset[],
  effective: ReadonlyMap<string, Selection>,
): string =>
  JSON.stringify(
    [remaining.map(({ reference }) => reference), [...effective].sort(compareKey)],
    (_, value: unknown) =>
      isPlainObject(value) ? Object.fromEntries(Object.entries(value).sort(compareKey)) : value,
  );

const byReference = (left: Preset, right: Preset): number =>
  compareString(left.reference, right.reference);

const compareKey = (left: readonly [string, unknown], right: readonly [string, unknown]): number =>
  compareString(left[0], right[0]);

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const assertActive = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new AquariusError("AI_ABORTED", "Config extraction was cancelled.");
};
