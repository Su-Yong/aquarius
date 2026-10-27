import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"], platform: "node", target: "node24.11", format: "esm",
  outDir: "dist", outExtensions: () => ({ js: ".mjs", dts: ".d.ts" }), tsconfig: "./tsconfig.json",
  clean: true, sourcemap: true, minify: false,
  dts: { tsconfig: "./tsconfig.build.json" },
});

