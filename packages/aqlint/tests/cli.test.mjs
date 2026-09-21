import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const name = metadata.name;

function checkCli(bin, name, version) {
  expect(readFileSync(bin, 'utf8')).toMatch(/^#!\/usr\/bin\/env node\n/);
  for (const args of [[], ['--help'], ['-h']]) {
    const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`Usage: ${name}`));
    expect(result.stdout).toMatch(/foundation/i);
  }
  for (const flag of ['--version', '-v']) {
    expect(execFileSync(process.execPath, [bin, flag], { encoding: 'utf8' }).trim()).toBe(version);
  }
  for (const args of [['--unknown'], ['input.txt'], ['--help', 'input.txt']]) {
    const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).not.toBe('');
    expect(result.stdout).toBe('');
  }
}

test('built CLI handles help, version, and invalid arguments', () => {
  checkCli(join(packageDir, metadata.bin[name]), name, metadata.version);
});

test('packed CLI installs and runs independently', () => {
  const directory = mkdtempSync(join(tmpdir(), `${name}-pack-`));
  try {
    expect(metadata.engines.node).toBe('>=24.11.0');
    expect(metadata.publishConfig.access).toBe('public');
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', directory], {
      cwd: packageDir, encoding: 'utf8',
    }));
    expect(packed.files.some(({ path }) => path === metadata.bin[name].replace(/^\.\//, ''))).toBe(true);
    expect(packed.files.every(({ path }) => !path.startsWith('src/') && !path.startsWith('tests/') && !path.includes('node_modules/'))).toBe(true);
    execFileSync('npm', ['install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packed.filename)], {
      encoding: 'utf8',
    });
    const installed = JSON.parse(readFileSync(join(directory, 'node_modules', name, 'package.json'), 'utf8'));
    expect(installed.version).toBe(metadata.version);
    const bin = join(directory, 'node_modules', '.bin', name);
    checkCli(bin, name, installed.version);
    expect(execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()).toBe(installed.version);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
