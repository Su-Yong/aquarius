import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  root: import.meta.dirname,
  resolve: {
    alias: {
      "@aqtools/core/adapter": fileURLToPath(
        new URL("../core/src/adapter/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    name: "antigravity",
    environment: "node",
    include: ["tests/**/*.test.{ts,mjs}"],
    testTimeout: 30_000,
  },
});
