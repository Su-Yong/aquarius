import type { FormatRule } from "@aquarius/core";

export const preferEarlyReturn: FormatRule = {
  id: "style/prefer-early-return",
  description: "Reduce nested branches using equivalent early returns.",
  scope: "file",
  buildPrompt: () => ({
    applicability: "Nested function branches that can be flattened through equivalent early returns.",
    transformation: "Place terminating or exceptional paths first and reduce indentation of the normal path. Leave already conforming code unchanged.",
    constraints: [
      "Preserve return values, exceptions, short-circuit evaluation, side effects, cleanup, and evaluation order.",
      "Do not turn a non-terminating branch into a return or move work across its execution condition.",
      "Do not introduce language-specific conventions into other languages.",
    ],
  }),
};
