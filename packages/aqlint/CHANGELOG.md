# @aqtools/aqlint

## 0.2.2

### Patch Changes

- Publish the Aquarius packages together under the `@aqtools` scope. Install the CLIs as `@aqtools/aqlint` and `@aqtools/aqfmt`, then run them with the `aqlint` and `aqfmt` commands.
- Updated dependencies
  - @aqtools/core@0.2.2

## 0.2.1

### Patch Changes

- Use the `@aqtools` npm scope for the core, rules, and Codex adapter packages. Configure `@aqtools/rules` as the rules plugin and `@aqtools/codex` as the Codex adapter. Continue using the `aqlint` and `aqfmt` commands and the `aquarius/` rule and preset IDs.
- Updated dependencies
  - @aqtools/core@0.2.1

## 0.2.0

### Minor Changes

- Add `extract-config` and improve lint reporting with provisional diagnostic updates. Use an explicitly configured adapter for AI analysis.

### Patch Changes

- Updated dependencies
  - @aquarius/core@0.2.0
