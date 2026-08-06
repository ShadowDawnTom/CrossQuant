import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

interface LockRecord {
  pid: number;
  token: string;
  createdAt: string;
}

export interface BackendProcessLock {
  readonly path: string;
  release(): void;
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(path: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Partial<LockRecord>;
    return Number.isInteger(record.pid) && typeof record.token === 'string' && typeof record.createdAt === 'string'
      ? record as LockRecord
      : null;
  } catch {
    return null;
  }
}

/**
 * The launcher is a convenience, not a safety boundary. This owner-only lock prevents two direct
 * `node dist/server.js`/Docker invocations from running strategy engines against one database.
 */
export function acquireBackendProcessLock(
  dataDirectory: string,
  options: { pid?: number; isProcessAlive?: (pid: number) => boolean } = {},
): BackendProcessLock {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  chmodSync(dataDirectory, 0o700);
  const path = join(dataDirectory, 'backend.lock');
  const pid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? processExists;
  const token = randomUUID();
  const record: LockRecord = { pid, token, createdAt: new Date().toISOString() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | null = null;
    try {
      descriptor = openSync(path, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
      closeSync(descriptor);
      descriptor = null;
      chmodSync(path, 0o600);
      let released = false;
      return {
        path,
        release: () => {
          if (released) return;
          released = true;
          const current = readLock(path);
          if (current?.token === token) {
            try {
              unlinkSync(path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
        },
      };
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const existing = readLock(path);
      // An unreadable lock is treated as live: deleting ambiguous ownership could enable two
      // trading processes. The user can inspect/remove it after verifying no backend is running.
      if (!existing || isProcessAlive(existing.pid)) {
        throw new Error(`backend_already_running:${path}`, { cause: error });
      }
      unlinkSync(path);
    }
  }
  throw new Error(`backend_lock_unavailable:${path}`);
}
