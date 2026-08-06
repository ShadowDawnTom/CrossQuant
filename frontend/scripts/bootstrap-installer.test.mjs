import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windowsPowerShell = process.platform === 'win32' ? 'powershell.exe' : process.env.GCT_TEST_POWERSHELL;

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeExecutable(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function makeSourceArchive(directory, label) {
  const source = join(directory, `source-${label}`, `gate-crossex-${label}`);
  mkdirSync(join(source, 'scripts'), { recursive: true });
  writeFileSync(join(source, 'package.json'), `${JSON.stringify({
    name: 'gate-crossex-terminal',
    private: true,
    version: '0.1.0',
  })}\n`);
  writeFileSync(join(source, 'package-lock.json'), `${JSON.stringify({ name: 'gate-crossex-terminal', lockfileVersion: 3 })}\n`);
  writeFileSync(join(source, 'bootstrap.sh'), '#!/bin/bash\nexit 0\n');
  writeExecutable(join(source, 'run'), '#!/bin/bash\nexit 0\n');
  writeFileSync(join(source, 'scripts/launcher.mjs'), '/* fixture */\n');
  writeFileSync(join(source, 'fixture-version.txt'), `${label}\n`);
  const archive = join(directory, `source-${label}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', dirname(source), source.split('/').at(-1)]);
  return archive;
}

function makeNodeArchive(directory, version) {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const assetRoot = `node-v${version}-${platform}-${architecture}`;
  const runtime = join(directory, 'runtime-fixture', assetRoot);
  writeExecutable(join(runtime, 'bin/node'), `#!/bin/bash
set -e
case "\${1:-}" in
  --version) echo "v${version}" ;;
  *npm-cli.js)
    if [ "\${2:-}" = "ci" ]; then
      mkdir -p node_modules/.bin node_modules/better-sqlite3 node_modules/@napi-rs/keyring
      touch node_modules/.bin/tsx
      chmod 700 node_modules/.bin/tsx
    fi
    ;;
  -e) ;;
esac
`);
  const npmCli = join(runtime, 'lib/node_modules/npm/bin/npm-cli.js');
  mkdirSync(dirname(npmCli), { recursive: true });
  writeFileSync(npmCli, '/* fixture */\n');
  const archive = join(directory, `${assetRoot}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', dirname(runtime), assetRoot]);
  return archive;
}

function makeWindowsSourceArchive(directory, label) {
  const source = join(directory, `windows-source-${label}`, `gate-crossex-${label}`);
  mkdirSync(join(source, 'scripts'), { recursive: true });
  writeFileSync(join(source, 'package.json'), `${JSON.stringify({
    name: 'gate-crossex-terminal',
    private: true,
    version: '0.1.0',
  })}\n`);
  writeFileSync(join(source, 'package-lock.json'), `${JSON.stringify({ name: 'gate-crossex-terminal', lockfileVersion: 3 })}\n`);
  writeFileSync(join(source, 'bootstrap.ps1'), 'exit 0\n');
  writeFileSync(join(source, 'run.ps1'), 'param([string]$Command = "start")\n');
  writeFileSync(join(source, 'scripts/launcher.mjs'), '/* fixture */\n');
  writeFileSync(join(source, 'fixture-version.txt'), `${label}\n`);
  const archive = join(directory, `windows-source-${label}.zip`);
  execFileSync('tar.exe', ['-a', '-cf', archive, '-C', dirname(source), basename(source)]);
  return archive;
}

function makeWindowsNodeArchive(directory, version) {
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const assetRoot = `node-v${version}-win-${architecture}`;
  const runtime = join(directory, 'windows-runtime-fixture', assetRoot);
  mkdirSync(runtime, { recursive: true });
  copyFileSync(process.execPath, join(runtime, 'node.exe'));
  const npmCli = join(runtime, 'node_modules/npm/bin/npm-cli.js');
  mkdirSync(dirname(npmCli), { recursive: true });
  writeFileSync(npmCli, `
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
if (process.argv[2] === 'ci') {
  mkdirSync('node_modules/.bin', { recursive: true });
  writeFileSync('node_modules/.bin/tsx.cmd', '@exit /b 0\\r\\n');
  for (const name of ['better-sqlite3', '@napi-rs/keyring']) {
    const directory = join('node_modules', ...name.split('/'));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    writeFileSync(join(directory, 'index.js'), 'module.exports = {}\\n');
  }
}
`);
  const archive = join(directory, `${assetRoot}.zip`);
  execFileSync('tar.exe', ['-a', '-cf', archive, '-C', dirname(runtime), assetRoot]);
  return archive;
}

test('Unix bootstrap installs atomically, updates, and preserves local state', {
  skip: process.platform === 'win32' ? 'Unix bootstrap test' : false,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-bootstrap-test-'));
  const installRoot = join(directory, 'Gate CrossEx Source');
  const nodeVersion = '24.18.0';
  const nodeArchive = makeNodeArchive(directory, nodeVersion);
  const baseEnvironment = {
    ...process.env,
    GCT_INSTALL_DIR: installRoot,
    GCT_NODE_VERSION: nodeVersion,
    GCT_NODE_ARCHIVE: nodeArchive,
    GCT_NODE_SHA256: sha256(nodeArchive),
  };
  try {
    const firstSource = makeSourceArchive(directory, 'first');
    execFileSync('/bin/bash', [join(root, 'bootstrap.sh')], {
      env: { ...baseEnvironment, GCT_SOURCE_ARCHIVE: firstSource },
      stdio: 'pipe',
    });
    assert.equal(readFileSync(join(installRoot, '.gate-crossex-source-install'), 'utf8').trim(), 'Gate CrossEx source install v1');
    assert.equal(readFileSync(join(installRoot, 'fixture-version.txt'), 'utf8').trim(), 'first');
    assert.equal(existsSync(join(installRoot, '.runtime/bin/node')), true);
    assert.equal(existsSync(join(installRoot, 'node_modules/.bin/tsx')), true);
    assert.equal(
      readFileSync(join(installRoot, '.local-data/dependencies.sha256'), 'utf8').trim(),
      sha256(join(installRoot, 'package-lock.json')),
    );

    writeFileSync(join(installRoot, '.local-data/preserved.txt'), 'local state\n');
    writeFileSync(join(installRoot, '.env'), 'SECRET=preserved\n');
    writeFileSync(join(installRoot, 'logs/preserved.log'), 'log\n');
    const secondSource = makeSourceArchive(directory, 'second');
    execFileSync('/bin/bash', [join(root, 'bootstrap.sh'), '--update'], {
      env: { ...baseEnvironment, GCT_SOURCE_ARCHIVE: secondSource },
      stdio: 'pipe',
    });
    assert.equal(readFileSync(join(installRoot, 'fixture-version.txt'), 'utf8').trim(), 'second');
    assert.equal(readFileSync(join(installRoot, '.local-data/preserved.txt'), 'utf8').trim(), 'local state');
    assert.equal(readFileSync(join(installRoot, '.env'), 'utf8').trim(), 'SECRET=preserved');
    assert.equal(readFileSync(join(installRoot, 'logs/preserved.log'), 'utf8').trim(), 'log');

    const unsafeRoot = join(directory, 'unrelated');
    mkdirSync(unsafeRoot);
    writeFileSync(join(unsafeRoot, 'keep.txt'), 'keep\n');
    const rejected = spawnSync('/bin/bash', [join(root, 'bootstrap.sh')], {
      env: { ...baseEnvironment, GCT_INSTALL_DIR: unsafeRoot, GCT_SOURCE_ARCHIVE: firstSource },
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /refusing to replace a non-empty directory/);
    assert.equal(readFileSync(join(unsafeRoot, 'keep.txt'), 'utf8'), 'keep\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('bootstrap shell scripts are syntactically valid', {
  skip: process.platform === 'win32' ? 'bash is not required on Windows' : false,
}, () => {
  execFileSync('bash', ['-n', join(root, 'bootstrap.sh')]);
  execFileSync('bash', ['-n', join(root, 'run')]);
});

test('Windows bootstrap installs, updates, and preserves local state', {
  skip: !windowsPowerShell ? 'Windows PowerShell is required' : false,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-windows-bootstrap-test-'));
  const installRoot = join(directory, 'Gate CrossEx Source');
  const nodeVersion = process.version.slice(1);
  try {
    const nodeArchive = makeWindowsNodeArchive(directory, nodeVersion);
    const baseEnvironment = {
      ...process.env,
      GCT_INSTALL_DIR: installRoot,
      GCT_NODE_VERSION: nodeVersion,
      GCT_NODE_ARCHIVE: nodeArchive,
      GCT_NODE_SHA256: sha256(nodeArchive),
    };
    const runBootstrap = (sourceArchive, extraEnvironment = {}) => execFileSync(windowsPowerShell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(root, 'bootstrap.ps1'),
    ], {
      env: { ...baseEnvironment, GCT_SOURCE_ARCHIVE: sourceArchive, ...extraEnvironment },
      stdio: 'pipe',
    });

    const firstSource = makeWindowsSourceArchive(directory, 'first');
    runBootstrap(firstSource);
    assert.equal(readFileSync(join(installRoot, '.gate-crossex-source-install'), 'utf8').trim(), 'Gate CrossEx source install v1');
    assert.equal(readFileSync(join(installRoot, 'fixture-version.txt'), 'utf8').trim(), 'first');
    assert.equal(existsSync(join(installRoot, '.runtime/node.exe')), true);
    assert.equal(existsSync(join(installRoot, 'node_modules/.bin/tsx.cmd')), true);

    writeFileSync(join(installRoot, '.local-data/preserved.txt'), 'local state\n');
    writeFileSync(join(installRoot, '.env'), 'SECRET=preserved\n');
    writeFileSync(join(installRoot, 'logs/preserved.log'), 'log\n');
    const secondSource = makeWindowsSourceArchive(directory, 'second');
    runBootstrap(secondSource);
    assert.equal(readFileSync(join(installRoot, 'fixture-version.txt'), 'utf8').trim(), 'second');
    assert.equal(readFileSync(join(installRoot, '.local-data/preserved.txt'), 'utf8').trim(), 'local state');
    assert.equal(readFileSync(join(installRoot, '.env'), 'utf8').trim(), 'SECRET=preserved');
    assert.equal(readFileSync(join(installRoot, 'logs/preserved.log'), 'utf8').trim(), 'log');

    const unsafeRoot = join(directory, 'unrelated');
    mkdirSync(unsafeRoot);
    writeFileSync(join(unsafeRoot, 'keep.txt'), 'keep\n');
    const rejected = spawnSync(windowsPowerShell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(root, 'bootstrap.ps1'),
    ], {
      env: { ...baseEnvironment, GCT_INSTALL_DIR: unsafeRoot, GCT_SOURCE_ARCHIVE: firstSource },
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /refusing to replace a non-empty directory/i);
    assert.equal(readFileSync(join(unsafeRoot, 'keep.txt'), 'utf8'), 'keep\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
