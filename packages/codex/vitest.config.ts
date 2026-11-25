import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  root: import.meta.dirname,
  resolve: {
    alias: {
      "@aquarius/core/adapter": fileURLToPath(
        new URL("../core/src/adapter/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    name: "codex",
    environment: "node",
    include: ["tests/**/*.test.{ts,mjs}"],
    testTimeout: 30_000,
  },
});
