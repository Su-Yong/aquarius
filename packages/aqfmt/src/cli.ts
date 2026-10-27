#!/usr/bin/env node
import rules from "@aquarius/rules";
import packageJson from "../package.json" with { type: "json" };
import { runCli } from "./cli/run";

process.exitCode = await runCli(packageJson.version, { "@aquarius/rules": rules });
