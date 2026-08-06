import Database from 'better-sqlite3';
import { chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath = process.argv[2] ? resolve(process.argv[2]) : null;
const destinationPath = process.argv[3] ? resolve(process.argv[3]) : null;
if (!sourcePath || !destinationPath || sourcePath === destinationPath) {
  throw new Error('Usage: backup-database.mjs <source.sqlite> <destination.sqlite>');
}
if (existsSync(destinationPath)) throw new Error(`Refusing to overwrite existing backup: ${destinationPath}`);

process.umask?.(0o077);
const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
try {
  const sourceIntegrity = database.pragma('quick_check(1)', { simple: true });
  if (sourceIntegrity !== 'ok') throw new Error(`Source database integrity check failed: ${String(sourceIntegrity)}`);
  await database.backup(destinationPath);
  chmodSync(destinationPath, 0o600);
} finally {
  database.close();
}

const backup = new Database(destinationPath, { readonly: true, fileMustExist: true });
try {
  const backupIntegrity = backup.pragma('quick_check(1)', { simple: true });
  if (backupIntegrity !== 'ok') throw new Error(`Backup integrity check failed: ${String(backupIntegrity)}`);
  const migrationTable = backup.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get();
  if (!migrationTable) throw new Error('Backup is missing the schema migration ledger');
} finally {
  backup.close();
}
