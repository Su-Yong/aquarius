#!/usr/bin/env node
import { parseArgs } from "node:util";
import packageJson from "../package.json" with { type: "json" };

try {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.version && !values.help) {
    console.log(packageJson.version);
  } else {
    console.log(`aqfmt — CLI foundation

Usage: aqfmt [options]

Options:
  -h, --help     Show help
  -v, --version  Show version

Formatting functionality is not implemented yet.`);
  }
} catch (error) {
  console.error(`aqfmt: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Run aqfmt --help for usage.");
  process.exitCode = 1;
}
