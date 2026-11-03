// Explicit mock fixture for a CLI demonstration. This does not call an AI model.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const lintRule = "aquarius/contracts/no-input-mutation";
const formatRule = "aquarius/style/prefer-early-return";
const oldText = `  } else {\n    items.sort();\n    return items.map((item) => item.trim());\n  }`;
const newText = `  }\n  items.sort();\n  return items.map((item) => item.trim());`;

export default {
  id: "explicit-demo-mock-not-a-real-model",
  async run(input) {
    const source = await readFile(join(input.projectRoot, "example.js"), "utf8");
    if (input.options.mode === "lint") {
      const line = source.split("\n").findIndex((text) => text.includes("items.sort();")) + 1;
      return {
        completedRuleIds: [lintRule],
        diagnostics: line === 0 ? [] : [{
          ruleIds: [lintRule],
          message: "items.sort() mutates the caller's array despite the non-mutation contract.",
          locations: [{ path: "example.js", line, column: source.split("\n")[line - 1].indexOf("items.sort") + 1 }],
          evidence: [
            { path: "example.js", line: 1, message: "The function promises not to change the caller's items." },
            { path: "example.js", line, message: "Array.sort() modifies the original items array in place." },
          ],
        }],
        unknowns: [],
        errors: [],
      };
    }
    if (input.options.mode === "format") {
      return {
        completedRuleIds: [formatRule],
        changes: source.includes(oldText) ? [{
          op: "replace", path: "example.js", oldText, newText, ruleIds: [formatRule],
        }] : [],
        warnings: [],
        errors: [],
      };
    }
    throw new Error("The demonstration mock requires an explicit lint or format mode.");
  },
};
