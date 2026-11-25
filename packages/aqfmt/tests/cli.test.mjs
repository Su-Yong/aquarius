import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { checkBuiltCli, checkPackedCli } from "../../../tests/cli-package.mjs";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("built CLI handles arguments, target selection, and JSON results", () => {
  checkBuiltCli(packageDir);
});

test("packed CLI resolves plugins and the adapter from the project", { timeout: 120_000 }, () => {
  checkPackedCli(workspaceRoot, packageDir);
});
