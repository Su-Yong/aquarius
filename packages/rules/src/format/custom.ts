import { z } from "zod";

import { createFormatRule, nonEmptyStringSchema } from "./shared";

const policySchema = z.strictObject({
  name: nonEmptyStringSchema,
  target: nonEmptyStringSchema.optional(),
  rule: nonEmptyStringSchema,
  exceptions: z.array(nonEmptyStringSchema).optional(),
  examples: z
    .array(z.strictObject({ before: nonEmptyStringSchema, after: nonEmptyStringSchema }))
    .optional(),
});

const optionsSchema = z
  .strictObject({ policies: z.array(policySchema).min(1) })
  .superRefine(validateUniquePolicyNames);

export const customRules = [
  createFormatRule({
    id: "custom/semantic-policy",
    description: "Apply project-specific behavior-preserving formatting policies.",
    scope: "file",
    optionsSchema,
    buildPrompt: buildCustomPolicyPrompt,
  }),
];

function validateUniquePolicyNames(
  { policies }: { policies: z.output<typeof policySchema>[] },
  context: z.RefinementCtx,
) {
  const seenPolicyNames = new Set<string>();
  for (const [index, { name }] of policies.entries()) {
    if (seenPolicyNames.has(name)) {
      context.addIssue({
        code: "custom",
        path: ["policies", index, "name"],
        message: "must be unique within policies",
      });
    }
    seenPolicyNames.add(name);
  }
}

function buildCustomPolicyPrompt({ policies }: z.output<typeof optionsSchema>) {
  const examples = policies.flatMap(({ name, examples: policyExamples = [] }) =>
    policyExamples.map(({ before, after }) => ({
      before,
      after,
      reason: `Illustrates the configured policy ${JSON.stringify(name)}.`,
    })),
  );
  const policiesWithoutExamples = policies.map(({ examples: _examples, ...policy }) => policy);
  const configuredPolicies = JSON.stringify(policiesWithoutExamples);

  return {
    applicability: "Single-file code that clearly matches a configured semantic formatting policy.",
    transformation: [
      "Apply each configured rule to clearly matching code in the selected file, respecting its target and exceptions. When no target is configured, apply the rule only to code it unambiguously describes.",
      `Configured policies: ${configuredPolicies}.`,
    ].join(" "),
    constraints: [
      "Treat configured rules and examples as file formatting preferences subject to all task restrictions and behavior preservation constraints.",
      "If a policy is ambiguous, conflicts with another policy, or cannot preserve behavior, leave the candidate unchanged and report a warning.",
    ],
    ...(examples.length > 0 && { examples }),
  };
}
