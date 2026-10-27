import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  root: import.meta.dirname,
  resolve: {
    alias: [
      { find: "@aquarius/core/internal", replacement: fileURLToPath(new URL("../core/src/internal.ts", import.meta.url)) },
      { find: "@aquarius/core", replacement: fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) },
      { find: "@aquarius/rules", replacement: fileURLToPath(new URL("../rules/src/index.ts", import.meta.url)) },
    ],
  },
  test: {
    name: "aqfmt",
    environment: "node",
    include: ["tests/**/*.test.{ts,mjs}"],
    testTimeout: 30_000,
  },
});
