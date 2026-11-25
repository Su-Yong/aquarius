# @aqtools/core

## 0.2.1

### Patch Changes

- Use the `@aqtools` npm scope for the core, rules, and Codex adapter packages. Configure `@aqtools/rules` as the rules plugin and `@aqtools/codex` as the Codex adapter. Continue using the `aqlint` and `aqfmt` commands and the `aquarius/` rule and preset IDs.

## 0.2.0

### Minor Changes

- Add the shared configuration extraction pipeline for both CLIs, including Git-aware source sampling, preset matching, and atomic configuration writes. Expand batched analysis and adapter support.
