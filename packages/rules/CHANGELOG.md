# @aqtools/rules

## 0.2.2

### Patch Changes

- Publish the Aquarius packages together under the `@aqtools` scope. Install the CLIs as `@aqtools/aqlint` and `@aqtools/aqfmt`, then run them with the `aqlint` and `aqfmt` commands.

## 0.2.1

### Patch Changes

- Use the `@aqtools` npm scope for the core, rules, and Codex adapter packages. Configure `@aqtools/rules` as the rules plugin and `@aqtools/codex` as the Codex adapter. Continue using the `aqlint` and `aqfmt` commands and the `aquarius/` rule and preset IDs.

## 0.2.0

### Minor Changes

- Expand the lint and formatting rule catalogs and split lint and format presets. Enable `structure/organize-blocks` in the `format-recommended` preset.
