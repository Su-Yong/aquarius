# @aqtools/codex

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

- Expose the read-only Codex CLI adapter as a standalone package for linting and formatting, with support for rule resources and provisional analysis updates.

### Patch Changes

- Updated dependencies
  - @aquarius/core@0.2.0
