import Database from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

const sourcePath = process.argv[2] ? resolve(process.argv[2]) : null;
const destinationPath = process.argv[3] ? resolve(process.argv[3]) : null;
if (!sourcePath || !destinationPath || sourcePath === destinationPath) {
  throw new Error('Usage: restore-database.mjs <backup.sqlite> <destination.sqlite>');
}
if (!existsSync(sourcePath)) throw new Error(`Backup does not exist: ${sourcePath}`);

process.umask?.(0o077);
const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
const temporaryPath = `${destinationPath}.restore-${process.pid}-${timestamp}.tmp`;
const previousPath = `${destinationPath}.pre-restore-${timestamp}`;

function validate(path) {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma('quick_check(1)', { simple: true });
    if (integrity !== 'ok') throw new Error(`Database integrity check failed for ${path}: ${String(integrity)}`);
    const migration = database.prepare(`
      SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1
    `).get();
    if (!migration) throw new Error(`Database has no applied migrations: ${path}`);
  } finally {
    database.close();
  }
}

validate(sourcePath);
const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
try {
  await source.backup(temporaryPath);
} finally {
  source.close();
}
chmodSync(temporaryPath, 0o600);
validate(temporaryPath);

if (existsSync(destinationPath)) {
  // Preserve the exact old file. The launcher stops the backend first, so no WAL writer can race
  // this atomic same-directory replacement.
  renameSync(destinationPath, previousPath);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${destinationPath}${suffix}`)) {
      renameSync(`${destinationPath}${suffix}`, `${previousPath}${suffix}`);
    }
  }
}
renameSync(temporaryPath, destinationPath);
chmodSync(dirname(destinationPath), 0o700);
chmodSync(destinationPath, 0o600);
validate(destinationPath);
console.log(`Database restored from ${sourcePath}.`);
if (existsSync(previousPath)) console.log(`Previous database preserved at ${previousPath}.`);
