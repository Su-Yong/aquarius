import { executeWithTimeout } from "../adapter/run";
import { AquariusError } from "../shared/errors";
import type { AdapterSession, AdapterSessionContext, RuleResource } from "../adapter/types";
import type { JsonObject, RunError, ToolKind } from "../shared/types";

import { buildSelectionPrompt, buildVerdictPrompt } from "./prompt";
import {
  parseSelection,
  parseVerdicts,
  selectionOutputSchema,
  verdictsOutputSchema,
} from "./schemas";

const SINGLE_REQUEST_RULE_LIMIT = 50;

export const createExtractionRunner = ({
  tool,
  session,
  context,
  timeoutMs,
  maxConcurrency,
}: {
  tool: ToolKind;
  session: AdapterSession;
  context: AdapterSessionContext;
  timeoutMs: number;
  maxConcurrency: number;
}) => {
  const request = (
    prompt: string,
    outputSchema: JsonObject,
    ruleResources: readonly RuleResource[],
    signal = context.signal,
  ) =>
    executeWithTimeout(
      session,
      { ...context, prompt, outputSchema, ruleResources },
      timeoutMs,
      signal,
      { keepAlive: true },
    );

  const analyze = async () => {
    const resources = context.ruleResources;
    if (resources.length <= SINGLE_REQUEST_RULE_LIMIT) {
      context.onProgress?.(`Analyzing ${resources.length} rules`);
      const verdicts = parseVerdicts(
        await request(buildVerdictPrompt(tool, resources), verdictsOutputSchema, resources),
      );
      return { verdicts, ruleIds: new Set(resources.map(({ ruleId }) => ruleId)) };
    }

    const categories = groupResources(resources);
    let groups = [...categories];
    if (categories.size > 1) {
      context.onProgress?.(`Selecting from ${categories.size} rule categories`);
      const selection = new Set(
        parseSelection(
          await request(
            buildSelectionPrompt(context.readableFiles, categories),
            selectionOutputSchema,
            [],
          ),
        ),
      );
      for (const id of selection) {
        if (!categories.has(id)) {
          throw new AquariusError("EXTRACT_RESPONSE_INVALID", `Unknown rule category: ${id}`);
        }
      }
      groups = groups.filter(([category]) => selection.has(category));
    }

    const ruleIds = new Set(groups.flatMap(([, rules]) => rules.map(({ ruleId }) => ruleId)));
    const batches: { category: string; rules: RuleResource[] }[] = [];
    for (const [category, rules] of groups) {
      for (let start = 0; start < rules.length; start += SINGLE_REQUEST_RULE_LIMIT) {
        batches.push({ category, rules: rules.slice(start, start + SINGLE_REQUEST_RULE_LIMIT) });
      }
    }
    const verdicts = await runCategoryRequests(
      batches,
      maxConcurrency,
      context.signal,
      async ({ category, rules }, signal) => {
        context.onProgress?.(`Analyzing rule category ${category}`);
        return parseVerdicts(
          await request(buildVerdictPrompt(tool, rules), verdictsOutputSchema, rules, signal),
        );
      },
    );
    return { verdicts: verdicts.flat(), ruleIds };
  };

  const repair = async (issues: RunError[], analyzedRuleIds: ReadonlySet<string>) => {
    const ids = new Set(issues.flatMap(({ ruleIds }) => ruleIds));
    const resources = context.ruleResources.filter(
      ({ ruleId }) => ids.has(ruleId) && analyzedRuleIds.has(ruleId),
    );
    if (resources.length === 0) return [];
    context.onProgress?.("Repairing invalid rule settings");
    return parseVerdicts(
      await request(buildVerdictPrompt(tool, resources, issues), verdictsOutputSchema, resources),
    );
  };

  return { analyze, repair };
};

const groupResources = (resources: readonly RuleResource[]): Map<string, RuleResource[]> => {
  const groups = new Map<string, RuleResource[]>();
  for (const resource of resources) {
    const [namespace, category, ...subpath] = resource.ruleId.split("/");
    const group = `${namespace}/${subpath.length > 0 ? category : "general"}`;
    const members = groups.get(group);
    if (members) members.push(resource);
    else groups.set(group, [resource]);
  }
  return groups;
};

const runCategoryRequests = async <Input, Output>(
  inputs: readonly Input[],
  maxConcurrency: number,
  signal: AbortSignal,
  analyze: (input: Input, signal: AbortSignal) => Promise<Output>,
): Promise<Output[]> => {
  const stop = new AbortController();
  const requestSignal = AbortSignal.any([signal, stop.signal]);
  const results: Output[] = [];
  let next = 0;

  const worker = async () => {
    while (next < inputs.length) {
      requestSignal.throwIfAborted();
      const index = next++;
      results[index] = await analyze(inputs[index]!, requestSignal);
    }
  };

  const workers = Array.from({ length: Math.min(maxConcurrency, inputs.length) }, worker);
  try {
    await Promise.all(workers);
  } catch (cause) {
    stop.abort();
    await Promise.allSettled(workers);
    throw cause;
  }
  return results;
};
