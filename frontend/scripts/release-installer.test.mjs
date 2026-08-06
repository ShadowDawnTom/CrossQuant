import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windowsPowerShell = process.platform === 'win32' ? 'powershell.exe' : process.env.GCT_TEST_POWERSHELL;

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function canonicalPath(path) {
  const canonical = realpathSync.native(path);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function assertSamePath(actual, expected) {
  assert.equal(canonicalPath(actual), canonicalPath(expected));
}

function makeFixture(directory, version, commitCharacter) {
  const bundle = join(directory, `fixture-${version}`, 'gate-crossex');
  const node = join(bundle, 'runtime/bin/node');
  mkdirSync(dirname(node), { recursive: true });
  writeFileSync(node, '#!/bin/sh\nexit 0\n');
  chmodSync(node, 0o755);
  const backend = join(bundle, 'app/apps/backend/dist/server.js');
  const frontend = join(bundle, 'app/apps/frontend/dist/index.html');
  mkdirSync(dirname(backend), { recursive: true });
  mkdirSync(dirname(frontend), { recursive: true });
  mkdirSync(join(bundle, 'app/migrations'), { recursive: true });
  writeFileSync(backend, '/* fixture */\n');
  writeFileSync(frontend, '<div id="root"></div>\n');
  writeFileSync(join(bundle, 'app/migrations/0001_fixture.sql'), 'SELECT 1;\n');
  const uninstaller = join(bundle, 'app/uninstall.sh');
  writeFileSync(uninstaller, '#!/bin/bash\nexit 0\n');
  chmodSync(uninstaller, 0o755);
  writeFileSync(join(bundle, 'release.json'), `${JSON.stringify({
    schema: 1,
    product: 'Gate CrossEx Local Trading Terminal',
    version,
    commit: commitCharacter.repeat(40),
    nodeVersion: '24.18.0',
    platform: 'darwin',
    arch: process.arch,
    builtAt: '2026-08-02T00:00:00.000Z',
  }, null, 2)}\n`);
  const archive = join(directory, `gate-crossex-${version}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', dirname(bundle), 'gate-crossex']);
  return { archive, checksum: sha256(archive), releaseId: `${version}-${commitCharacter.repeat(12)}` };
}

function testEnvironment(installationRoot) {
  return {
    ...process.env,
    GCT_INSTALL_ROOT: installationRoot,
    GCT_LAUNCH_AGENT_PATH: join(installationRoot, 'test-launch-agent', 'com.yourquantguy.gate-crossex.plist'),
    GCT_LAUNCHER_APP_PATH: join(installationRoot, 'test-launcher', 'Gate CrossEx.app'),
    GCT_SKIP_SERVICE: '1',
  };
}

function installerEnvironment(installationRoot, fixture) {
  return {
    ...testEnvironment(installationRoot),
    GCT_ARCHIVE: fixture.archive,
    GCT_SHA256: fixture.checksum,
  };
}

function withoutInheritedPowerShellModulePath(environment) {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
}

function windowsTestEnvironment(installationRoot) {
  const portableEnvironment = process.platform === 'win32' ? {} : {
    OS: 'Windows_NT',
    LOCALAPPDATA: dirname(installationRoot),
    APPDATA: join(dirname(installationRoot), 'AppData'),
    USERPROFILE: dirname(installationRoot),
  };
  return {
    // Actions launches Node from pwsh. Its PSModulePath hides Windows PowerShell's
    // built-in modules when inherited by powershell.exe, so let the child rebuild it.
    ...withoutInheritedPowerShellModulePath(process.env),
    ...portableEnvironment,
    GCT_INSTALL_ROOT: installationRoot,
    GCT_TASK_NAME: 'Gate CrossEx Installer Test',
    GCT_SHORTCUT_PATH: join(installationRoot, 'test-shortcut', 'Gate CrossEx.lnk'),
    GCT_SKIP_SERVICE: '1',
    GCT_OPEN_BROWSER: '0',
  };
}

test('Windows installer environment does not inherit a foreign PowerShell module path', () => {
  assert.deepEqual(withoutInheritedPowerShellModulePath({
    Path: 'system-bin',
    PSModulePath: 'pwsh-modules',
    pSmOdUlEpAtH: 'duplicate-module-path',
  }), { Path: 'system-bin' });
});

test('Windows scripts hash files without PowerShell utility module auto-loading', () => {
  for (const relativePath of [
    'bootstrap.ps1',
    'install.ps1',
    'run.ps1',
    'scripts/test-windows-release-install.ps1',
  ]) {
    const contents = readFileSync(join(root, relativePath), 'utf8');
    assert.doesNotMatch(contents, /\bGet-FileHash\b/, relativePath);
    assert.match(contents, /\[Security\.Cryptography\.SHA256\]::Create\(\)/, relativePath);
  }
});

test('Windows release bundler invokes npm through Node instead of a batch file', () => {
  const contents = readFileSync(join(root, 'scripts/build-release-bundle-windows.mjs'), 'utf8');
  assert.doesNotMatch(contents, /run\(['"]npm\.cmd['"]/);
  assert.match(contents, /process\.env\.npm_execpath/);
  assert.match(contents, /run\(process\.execPath, \[npmCliPath\(\)/);
});

test('release lockfile includes native keyring packages for every release target', () => {
  const lockfile = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  for (const target of [
    '@napi-rs/keyring-darwin-arm64',
    '@napi-rs/keyring-darwin-x64',
    '@napi-rs/keyring-win32-arm64-msvc',
    '@napi-rs/keyring-win32-x64-msvc',
  ]) {
    const dependency = lockfile.packages[`node_modules/${target}`];
    assert.equal(dependency?.version, '1.3.0', target);
    assert.equal(dependency?.optional, true, target);
  }
});

test('Windows release installer uses long-path-capable archive extraction', () => {
  const contents = readFileSync(join(root, 'install.ps1'), 'utf8');
  assert.doesNotMatch(contents, /^\s*Expand-Archive\b/m);
  assert.match(contents, /Get-Command tar\.exe/);
  assert.match(contents, /& \$Tar -xf \$ArchivePath -C \$Destination/);
});

function makeWindowsFixture(directory, version, commitCharacter) {
  const bundle = join(directory, `windows-fixture-${version}`, 'gate-crossex');
  const node = join(bundle, 'runtime/node.exe');
  mkdirSync(dirname(node), { recursive: true });
  copyFileSync(process.execPath, node);
  const backend = join(bundle, 'app/apps/backend/dist/server.js');
  const frontend = join(bundle, 'app/apps/frontend/dist/index.html');
  mkdirSync(dirname(backend), { recursive: true });
  mkdirSync(dirname(frontend), { recursive: true });
  mkdirSync(join(bundle, 'app/migrations'), { recursive: true });
  writeFileSync(backend, '/* fixture */\n');
  writeFileSync(frontend, '<div id="root"></div>\n');
  writeFileSync(join(bundle, 'app/migrations/0001_fixture.sql'), 'SELECT 1;\n');
  for (const dependency of ['better-sqlite3', '@napi-rs/keyring']) {
    const dependencyRoot = join(bundle, 'app/node_modules', dependency);
    mkdirSync(dependencyRoot, { recursive: true });
    writeFileSync(join(dependencyRoot, 'package.json'), `${JSON.stringify({ name: dependency, version: '1.0.0', main: 'index.js' })}\n`);
    writeFileSync(join(dependencyRoot, 'index.js'), 'module.exports = {};\n');
  }
  copyFileSync(join(root, 'uninstall.ps1'), join(bundle, 'app/uninstall.ps1'));
  mkdirSync(join(bundle, 'app/packaging'), { recursive: true });
  cpSync(join(root, 'packaging/windows'), join(bundle, 'app/packaging/windows'), { recursive: true });
  writeFileSync(join(bundle, 'release.json'), `${JSON.stringify({
    schema: 1,
    product: 'Gate CrossEx Local Trading Terminal',
    version,
    commit: commitCharacter.repeat(40),
    nodeVersion: process.version.slice(1),
    platform: 'win32',
    arch: process.arch,
    builtAt: '2026-08-02T00:00:00.000Z',
  }, null, 2)}\n`);
  const archive = join(directory, `gate-crossex-windows-${version}.zip`);
  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
  execFileSync(tar, ['-a', '-cf', archive, '-C', dirname(bundle), 'gate-crossex']);
  return { archive, checksum: sha256(archive), releaseId: `${version}-${commitCharacter.repeat(12)}` };
}

test('macOS bootstrap installer verifies, updates, preserves data, and purges only explicitly', {
  skip: process.platform !== 'darwin' ? 'macOS installer test' : false,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-installer-test-'));
  const installationRoot = join(directory, "Install Root with spaces and ' quote");
  try {
    const first = makeFixture(directory, '0.1.0', 'a');
    const second = makeFixture(directory, '0.1.1', 'b');
    execFileSync('/bin/bash', [join(root, 'install.sh')], {
      env: installerEnvironment(installationRoot, first),
      stdio: 'pipe',
    });
    assert.equal(lstatSync(join(installationRoot, 'current')).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(installationRoot, 'current')), join(installationRoot, 'versions', first.releaseId));
    assert.equal(readFileSync(join(installationRoot, 'versions', first.releaseId, '.archive-sha256'), 'utf8').trim(), first.checksum);
    assert.equal(readFileSync(join(installationRoot, 'uninstall.sh'), 'utf8'), '#!/bin/bash\nexit 0\n');

    // Reinstalling an identical verified release is idempotent.
    execFileSync('/bin/bash', [join(root, 'install.sh')], {
      env: installerEnvironment(installationRoot, first),
      stdio: 'pipe',
    });

    const rejected = spawnSync('/bin/bash', [join(root, 'install.sh')], {
      env: { ...installerEnvironment(installationRoot, first), GCT_SHA256: '0'.repeat(64) },
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /checksum verification failed/);
    assert.equal(readlinkSync(join(installationRoot, 'current')), join(installationRoot, 'versions', first.releaseId));

    execFileSync('/bin/bash', [join(root, 'install.sh')], {
      env: installerEnvironment(installationRoot, second),
      stdio: 'pipe',
    });
    assert.equal(readlinkSync(join(installationRoot, 'current')), join(installationRoot, 'versions', second.releaseId));
    assert.equal(existsSync(join(installationRoot, 'versions', first.releaseId)), true);

    writeFileSync(join(installationRoot, 'data', 'preserved.txt'), 'keep\n');
    execFileSync('/bin/bash', [join(root, 'uninstall.sh')], {
      env: testEnvironment(installationRoot),
      stdio: 'pipe',
    });
    assert.equal(existsSync(join(installationRoot, 'versions')), false);
    assert.equal(existsSync(join(installationRoot, 'uninstall.sh')), true);
    assert.equal(readFileSync(join(installationRoot, 'data', 'preserved.txt'), 'utf8'), 'keep\n');

    execFileSync('/bin/bash', [join(root, 'uninstall.sh'), '--purge'], {
      env: testEnvironment(installationRoot),
      stdio: 'pipe',
    });
    assert.equal(existsSync(installationRoot), false);

    const unrelatedRoot = join(directory, 'unrelated-directory');
    mkdirSync(unrelatedRoot);
    writeFileSync(join(unrelatedRoot, 'keep.txt'), 'keep\n');
    const unsafePurge = spawnSync('/bin/bash', [join(root, 'uninstall.sh'), '--purge'], {
      env: testEnvironment(unrelatedRoot),
      encoding: 'utf8',
    });
    assert.notEqual(unsafePurge.status, 0);
    assert.match(unsafePurge.stderr, /refusing to purge an unrecognized installation root/);
    assert.equal(readFileSync(join(unrelatedRoot, 'keep.txt'), 'utf8'), 'keep\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release shell scripts are syntactically valid', {
  skip: process.platform === 'win32' ? 'bash is not required on Windows' : false,
}, () => {
  execFileSync('bash', ['-n', join(root, 'install.sh')]);
  execFileSync('bash', ['-n', join(root, 'uninstall.sh')]);
});

test('Windows bootstrap installer verifies, updates, preserves data, and purges only explicitly', {
  skip: !windowsPowerShell ? 'Windows or portable PowerShell is required' : false,
  timeout: 120_000,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-windows-installer-test-'));
  const installationRoot = join(directory, "Install Root with spaces and ' quote");
  try {
    const first = makeWindowsFixture(directory, '0.1.0', 'c');
    const second = makeWindowsFixture(directory, '0.1.1', 'd');
    const runInstaller = (fixture, extraEnvironment = {}) => execFileSync(windowsPowerShell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(root, 'install.ps1'),
    ], {
      env: {
        ...windowsTestEnvironment(installationRoot),
        GCT_ARCHIVE: fixture.archive,
        GCT_SHA256: fixture.checksum,
        ...extraEnvironment,
      },
      stdio: 'pipe',
    });

    runInstaller(first);
    assertSamePath(readFileSync(join(installationRoot, 'current-release.txt'), 'utf8').trim(), join(installationRoot, 'versions', first.releaseId));
    assert.equal(readFileSync(join(installationRoot, 'versions', first.releaseId, '.archive-sha256'), 'utf8').trim(), first.checksum);
    assert.equal(existsSync(join(installationRoot, 'uninstall.ps1')), true);

    runInstaller(first);
    const rejected = spawnSync(windowsPowerShell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(root, 'install.ps1'),
    ], {
      env: {
        ...windowsTestEnvironment(installationRoot),
        GCT_ARCHIVE: first.archive,
        GCT_SHA256: '0'.repeat(64),
      },
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /checksum verification failed/i);
    assertSamePath(readFileSync(join(installationRoot, 'current-release.txt'), 'utf8').trim(), join(installationRoot, 'versions', first.releaseId));

    runInstaller(second);
    assertSamePath(readFileSync(join(installationRoot, 'current-release.txt'), 'utf8').trim(), join(installationRoot, 'versions', second.releaseId));
    assert.equal(existsSync(join(installationRoot, 'versions', first.releaseId)), true);

    writeFileSync(join(installationRoot, 'data', 'preserved.txt'), 'keep\n');
    execFileSync(windowsPowerShell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(installationRoot, 'uninstall.ps1'),
    ], { env: windowsTestEnvironment(installationRoot), stdio: 'pipe' });
    assert.equal(existsSync(join(installationRoot, 'versions')), false);
    assert.equal(existsSync(join(installationRoot, 'uninstall.ps1')), true);
    assert.equal(readFileSync(join(installationRoot, 'data', 'preserved.txt'), 'utf8'), 'keep\n');

    execFileSync(windowsPowerShell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(installationRoot, 'uninstall.ps1'),
      '-Purge',
    ], { env: windowsTestEnvironment(installationRoot), stdio: 'pipe' });
    assert.equal(existsSync(installationRoot), false);

    const unrelatedRoot = join(directory, 'unrelated-directory');
    mkdirSync(unrelatedRoot);
    writeFileSync(join(unrelatedRoot, 'keep.txt'), 'keep\n');
    const unsafePurge = spawnSync(windowsPowerShell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', join(root, 'uninstall.ps1'),
      '-Purge',
    ], { env: windowsTestEnvironment(unrelatedRoot), encoding: 'utf8' });
    assert.notEqual(unsafePurge.status, 0);
    assert.match(`${unsafePurge.stdout}\n${unsafePurge.stderr}`, /refusing to uninstall an unrecognized installation root/i);
    assert.equal(readFileSync(join(unrelatedRoot, 'keep.txt'), 'utf8'), 'keep\n');
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('Windows PowerShell release scripts are syntactically valid', {
  skip: !windowsPowerShell ? 'Windows or portable PowerShell is required' : false,
}, () => {
  const scripts = [
    'bootstrap.ps1',
    'install.ps1',
    'run.ps1',
    'uninstall.ps1',
    'packaging/windows/service.ps1',
    'packaging/windows/gate-crossex.ps1',
    'scripts/test-windows-release-install.ps1',
    'scripts/test-powershell-syntax.ps1',
  ].map((script) => join(root, script));
  execFileSync(windowsPowerShell, [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', join(root, 'scripts/test-powershell-syntax.ps1'),
    ...scripts,
  ]);
});

test('Windows scheduled-task wrapper enables graceful child shutdown', () => {
  const service = readFileSync(join(root, 'packaging/windows/service.ps1'), 'utf8');
  const server = readFileSync(join(root, 'apps/backend/src/server.ts'), 'utf8');
  assert.match(service, /GCT_WINDOWS_SERVICE_PARENT_PID\s*=\s*\[string\]\$PID/);
  assert.match(server, /monitorWindowsServiceParent/);
});
