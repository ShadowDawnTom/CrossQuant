import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';

const databasePath = resolve(process.argv[2] ?? '.local-data/gate-crossex.sqlite');
process.umask?.(0o077);
const database = new Database(databasePath, { fileMustExist: true });
try {
  const before = database.pragma('quick_check(1)', { simple: true });
  if (before !== 'ok') throw new Error(`Database integrity check failed before maintenance: ${String(before)}`);
  database.pragma('wal_checkpoint(TRUNCATE)');
  database.pragma('optimize');
  database.exec('VACUUM');
  const after = database.pragma('quick_check(1)', { simple: true });
  if (after !== 'ok') throw new Error(`Database integrity check failed after maintenance: ${String(after)}`);
  chmodSync(databasePath, 0o600);
  console.log(`Database optimized and verified: ${databasePath}`);
} finally {
  database.close();
}
