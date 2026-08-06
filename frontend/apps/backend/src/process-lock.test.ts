import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireBackendProcessLock } from './process-lock.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('backend process lock', () => {
  it('rejects a second live owner and releases only its own token', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gct-lock-'));
    directories.push(directory);
    const first = acquireBackendProcessLock(directory, { pid: 101, isProcessAlive: (pid) => pid === 101 });
    expect(() => acquireBackendProcessLock(directory, { pid: 202, isProcessAlive: (pid) => pid === 101 }))
      .toThrow(/backend_already_running/);
    if (process.platform !== 'win32') {
      expect(statSync(first.path).mode & 0o777).toBe(0o600);
    }
    first.release();
    const second = acquireBackendProcessLock(directory, { pid: 202, isProcessAlive: () => false });
    expect(JSON.parse(readFileSync(second.path, 'utf8'))).toMatchObject({ pid: 202 });
    second.release();
  });

  it('replaces a stale lock', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gct-lock-'));
    directories.push(directory);
    const stale = acquireBackendProcessLock(directory, { pid: 101, isProcessAlive: () => false });
    // Do not release: the second acquisition should prove the recorded pid is stale and replace it.
    const replacement = acquireBackendProcessLock(directory, { pid: 202, isProcessAlive: () => false });
    stale.release();
    expect(JSON.parse(readFileSync(replacement.path, 'utf8'))).toMatchObject({ pid: 202 });
    replacement.release();
  });
});
