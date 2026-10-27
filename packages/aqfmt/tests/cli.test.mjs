import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { checkBuiltCli, checkPackedCli } from '../../../tests/cli-package.mjs';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('built CLI handles help, version, and invalid arguments', () => {
  checkBuiltCli(packageDir);
});

test('packed CLI installs with core and rules tarballs and runs independently', { timeout: 120_000 }, () => {
  checkPackedCli(workspaceRoot, packageDir);
});
