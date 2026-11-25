import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    adapter: "src/adapter/index.ts",
    runtime: "src/runtime/index.ts",
    cli: "src/cli/index.ts",
  },
  platform: "node",
  target: "node24.11",
  format: "esm",
  outDir: "dist",
  outExtensions: () => ({ js: ".mjs", dts: ".d.ts" }),
  tsconfig: "./tsconfig.json",
  clean: true,
  sourcemap: true,
  minify: false,
  dts: true,
});
