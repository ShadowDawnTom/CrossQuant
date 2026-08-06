import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const nodeVersion = process.env.GCT_RELEASE_NODE_VERSION ?? '24.18.0';
const releasePlatform = process.env.GCT_RELEASE_PLATFORM ?? process.platform;
const releaseArch = process.env.GCT_RELEASE_ARCH ?? process.arch;

if (releasePlatform !== 'darwin') {
  throw new Error(`The first release milestone supports macOS bundles only; received ${releasePlatform}-${releaseArch}`);
}
if (!['arm64', 'x64'].includes(releaseArch)) throw new Error(`Unsupported macOS architecture: ${releaseArch}`);
if (process.platform !== releasePlatform || process.arch !== releaseArch) {
  throw new Error(`Native release bundles must be built on their target. Host is ${process.platform}-${process.arch}; target is ${releasePlatform}-${releaseArch}.`);
}
if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) throw new Error(`Invalid GCT_RELEASE_NODE_VERSION: ${nodeVersion}`);

const outputDirectory = resolve(process.env.GCT_RELEASE_OUTPUT_DIR ?? join(root, 'release'));
const cacheDirectory = resolve(process.env.GCT_RELEASE_CACHE_DIR ?? join(root, '.release-cache'));
const temporaryRoot = mkdtempSync(join(tmpdir(), 'gate-crossex-release-'));
const bundleRoot = join(temporaryRoot, 'gate-crossex');
const appRoot = join(bundleRoot, 'app');
const runtimeRoot = join(bundleRoot, 'runtime');
const assetName = `gate-crossex-${releasePlatform}-${releaseArch}.tar.gz`;
const outputPath = join(outputDirectory, assetName);
const workspaceDirectories = [
  'apps/backend',
  'apps/frontend',
  'packages/domain',
  'packages/public-data',
  'packages/shared-types',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr.trim());
  return result.stdout.trim();
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`);
  mkdirSync(dirname(destination), { recursive: true });
  const partial = `${destination}.partial-${process.pid}`;
  try {
    await pipeline(response.body, createWriteStream(partial, { mode: 0o600 }));
    renameSync(partial, destination);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function copy(relativePath, destination = join(appRoot, relativePath)) {
  const source = join(root, relativePath);
  if (!existsSync(source)) throw new Error(`Release input is missing: ${relativePath}`);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: false });
}

async function installRuntime() {
  const nodeArchive = `node-v${nodeVersion}-darwin-${releaseArch}.tar.gz`;
  const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
  const cachedArchive = join(cacheDirectory, nodeArchive);
  const sumsPath = join(cacheDirectory, `SHASUMS256-v${nodeVersion}.txt`);
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  if (!existsSync(sumsPath)) await download(`${baseUrl}/SHASUMS256.txt`, sumsPath);
  const checksumLine = readFileSync(sumsPath, 'utf8').split(/\r?\n/).find((line) => line.endsWith(`  ${nodeArchive}`));
  if (!checksumLine) throw new Error(`Node checksum manifest does not contain ${nodeArchive}`);
  const expected = checksumLine.split(/\s+/)[0];
  if (!existsSync(cachedArchive) || sha256(cachedArchive) !== expected) {
    rmSync(cachedArchive, { force: true });
    await download(`${baseUrl}/${nodeArchive}`, cachedArchive);
  }
  if (sha256(cachedArchive) !== expected) throw new Error(`Node.js checksum verification failed for ${nodeArchive}`);

  const extractionRoot = join(temporaryRoot, 'node-extract');
  mkdirSync(extractionRoot);
  run('tar', ['-xzf', cachedArchive, '-C', extractionRoot]);
  const extracted = join(extractionRoot, nodeArchive.slice(0, -'.tar.gz'.length));
  const sourceNode = join(extracted, 'bin', 'node');
  const npmCli = join(extracted, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(sourceNode) || !existsSync(npmCli)) throw new Error('Official Node archive is incomplete');
  mkdirSync(join(runtimeRoot, 'bin'), { recursive: true });
  cpSync(sourceNode, join(runtimeRoot, 'bin', 'node'));
  chmodSync(join(runtimeRoot, 'bin', 'node'), 0o755);
  cpSync(join(extracted, 'LICENSE'), join(runtimeRoot, 'LICENSE'));
  return { sourceNode, npmCli };
}

function copyApplicationInputs() {
  copy('package.json');
  copy('package-lock.json');
  for (const workspace of workspaceDirectories) {
    copy(`${workspace}/package.json`);
  }
  for (const builtDirectory of [
    'apps/backend/dist',
    'apps/frontend/dist',
    'packages/domain/dist',
    'packages/public-data/dist',
    'packages/shared-types/dist',
  ]) {
    copy(builtDirectory);
  }
  copy('migrations');
  for (const script of ['backup-database.mjs', 'restore-database.mjs', 'maintain-database.mjs']) {
    copy(`scripts/${script}`);
  }
  copy('uninstall.sh', join(appRoot, 'uninstall.sh'));
  for (const document of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md']) copy(document);
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Could not allocate a smoke-test port'));
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function smokeTestPackagedBackend() {
  const port = await freePort();
  const dataDirectory = join(temporaryRoot, 'smoke-data');
  const node = join(runtimeRoot, 'bin', 'node');
  const child = spawn(node, [join(appRoot, 'apps/backend/dist/server.js')], {
    cwd: appRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      GCT_DATA_DIR: dataDirectory,
      GCT_MIGRATIONS_DIR: join(appRoot, 'migrations'),
      GCT_FRONTEND_DIST_DIR: join(appRoot, 'apps/frontend/dist'),
      GCT_CREDENTIAL_ENV_PATH: join(dataDirectory, 'credentials.env'),
      GCT_DISABLE_OS_KEYCHAIN: '1',
      GCT_PORT: String(port),
      GCT_FRONTEND_PORT: String(port),
      GCT_FRONTEND_ORIGIN: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const deadline = Date.now() + 30_000;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Packaged backend exited during smoke test:\n${output.slice(-4000)}`);
      try {
        const [health, page] = await Promise.all([
          fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) }),
          fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) }),
        ]);
        if (health.ok && page.ok && (await page.text()).includes('<div id="root">')) return;
      } catch {
        // Still starting.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    throw new Error(`Packaged backend did not become healthy:\n${output.slice(-4000)}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolveExit) => {
        const timeout = setTimeout(resolveExit, 30_000);
        timeout.unref?.();
        child.once('exit', () => {
          clearTimeout(timeout);
          resolveExit();
        });
      });
    }
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

function assertProductionTree() {
  const forbidden = new Set(['.git', '.env', '.local-data', 'logs']);
  for (const entry of readdirSync(appRoot)) {
    if (forbidden.has(entry)) throw new Error(`Forbidden release entry: ${entry}`);
  }
  for (const required of [
    join(runtimeRoot, 'bin', 'node'),
    join(appRoot, 'apps/backend/dist/server.js'),
    join(appRoot, 'apps/frontend/dist/index.html'),
    join(appRoot, 'node_modules/better-sqlite3'),
    join(appRoot, 'node_modules/@napi-rs/keyring'),
    join(appRoot, 'migrations/0001_foundation.sql'),
    join(appRoot, 'uninstall.sh'),
  ]) {
    if (!existsSync(required)) throw new Error(`Packaged release is missing ${required}`);
  }
  if ((statSync(join(appRoot, 'uninstall.sh')).mode & 0o100) === 0) {
    throw new Error('Packaged uninstaller is not executable');
  }
}

async function main() {
  try {
    if (process.env.GCT_REQUIRE_CLEAN === '1' && commandOutput('git', ['status', '--short'])) {
      throw new Error('Refusing to create a release from a dirty worktree');
    }
    for (const workspace of workspaceDirectories) {
      const manifest = JSON.parse(readFileSync(join(root, workspace, 'package.json'), 'utf8'));
      if (manifest.version !== packageJson.version) {
        throw new Error(`${workspace}/package.json version ${manifest.version} does not match root version ${packageJson.version}`);
      }
      for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
        if (name.startsWith('@gate-crossex/') && version !== packageJson.version) {
          throw new Error(`${workspace} depends on ${name}@${version}; expected ${packageJson.version}`);
        }
      }
    }
    console.log('Building production application...');
    run('npm', ['run', 'build']);
    mkdirSync(appRoot, { recursive: true });
    const { sourceNode, npmCli } = await installRuntime();
    copyApplicationInputs();

    console.log(`Installing production dependencies under Node ${nodeVersion}...`);
    run(sourceNode, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--strict-allow-scripts'], {
      cwd: appRoot,
      env: { ...process.env, PATH: `${dirname(sourceNode)}:${process.env.PATH ?? ''}` },
    });

    const commit = process.env.GITHUB_SHA ?? commandOutput('git', ['rev-parse', 'HEAD']);
    if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`Invalid release commit: ${commit}`);
    const release = {
      schema: 1,
      product: 'Gate CrossEx Local Trading Terminal',
      version: packageJson.version,
      commit: commit.toLowerCase(),
      nodeVersion,
      platform: releasePlatform,
      arch: releaseArch,
      builtAt: new Date().toISOString(),
    };
    writeFileSync(join(bundleRoot, 'release.json'), `${JSON.stringify(release, null, 2)}\n`, { mode: 0o600 });
    assertProductionTree();
    console.log('Smoke-testing the packaged backend with its bundled Node runtime...');
    await smokeTestPackagedBackend();

    mkdirSync(outputDirectory, { recursive: true });
    rmSync(outputPath, { force: true });
    run('tar', ['-czf', outputPath, '-C', temporaryRoot, basename(bundleRoot)]);
    const digest = sha256(outputPath);
    writeFileSync(join(outputDirectory, `SHA256SUMS-${releasePlatform}-${releaseArch}`), `${digest}  ${assetName}\n`);
    console.log(`Created ${outputPath} (${Math.ceil(statSync(outputPath).size / 1024 / 1024)} MiB)`);
    console.log(`SHA-256 ${digest}`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
