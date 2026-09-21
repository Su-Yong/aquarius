import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  platform: "node",
  target: "node24.11",
  format: "esm",
  outDir: "dist",
  outExtensions: () => ({ js: ".mjs" }),
  tsconfig: "./tsconfig.json",
  clean: true,
  sourcemap: true,
  minify: false,
  dts: false,
});
