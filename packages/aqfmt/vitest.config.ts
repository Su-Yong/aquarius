import { defineProject } from "vitest/config";

export default defineProject({
  root: import.meta.dirname,
  resolve: { tsconfigPaths: true },
  test: {
    name: "aqfmt",
    environment: "node",
    include: ["tests/**/*.test.{ts,mjs}"],
    testTimeout: 30_000,
  },
});
