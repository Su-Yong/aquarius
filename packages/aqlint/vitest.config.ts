import { defineProject } from "vitest/config";

export default defineProject({
  root: import.meta.dirname,
  test: {
    name: "aqlint",
    environment: "node",
    include: ["tests/**/*.test.{ts,mjs}"],
    testTimeout: 30_000,
  },
});
