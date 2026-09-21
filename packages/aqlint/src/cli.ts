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
    console.log(`aqlint — CLI foundation

Usage: aqlint [options]

Options:
  -h, --help     Show help
  -v, --version  Show version

Linting functionality is not implemented yet.`);
  }
} catch (error) {
  console.error(`aqlint: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Run aqlint --help for usage.");
  process.exitCode = 1;
}
