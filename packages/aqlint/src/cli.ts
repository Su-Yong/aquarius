#!/usr/bin/env node
import { runCli } from "./cli/run";
import rules from "@aquarius/rules";
import packageJson from "../package.json" with { type: "json" };

process.exitCode = await runCli(packageJson.version, { "@aquarius/rules": rules });
