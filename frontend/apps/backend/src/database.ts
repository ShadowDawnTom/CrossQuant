import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DatabaseStatus {
  state: 'ok' | 'error';
  migrationCount: number;
  currentMigration: string | null;
}

interface AppliedMigration {
  id: string;
  checksum: string;
}

const CURRENT_SCHEMA_TABLES = [
  'audit_events',
  'candle_cache',
  'crossex_instruments',
  'execution_fills',
  'execution_orders',
  'execution_strategies',
  'execution_strategy_logs',
  'funding_history_coverage',
  'funding_research_evaluations',
  'funding_research_positions',
  'funding_research_settlements',
  'funding_research_variants',
  'funding_rate_history',
  'funding_scan_observations',
  'funding_scan_summaries',
  'hyperliquid_perp_metadata',
  'schema_migrations',
] as const;

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export interface OpenDatabaseOptions {
  startupIntegrityMaxBytes?: number;
}

const DEFAULT_STARTUP_INTEGRITY_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Windows 和 Linux 的发布包可能只改变 SQL 换行符。旧库保留原始字节校验值，
 * 因此同时接受 LF/CRLF 两种等价值；SQL 内容有任何其他变化仍会拒绝启动。
 */
function compatibleMigrationChecksums(sql: string): Set<string> {
  const lf = sql.replace(/\r\n?/g, '\n');
  return new Set([migrationChecksum(lf), migrationChecksum(lf.replace(/\n/g, '\r\n'))]);
}

function applyMigrationDirectives(database: Database.Database, sql: string): void {
  for (const line of sql.split(/\r?\n/)) {
    const directive = /^-- @ensure-column ([a-z][a-z0-9_]*) ([a-z][a-z0-9_]*) ([A-Z][A-Z0-9_ ()']*)$/.exec(line.trim());
    if (!directive) continue;
    const [, tableName, columnName, definition] = directive;
    if (!tableName || !columnName || !definition) throw new Error(`Invalid migration directive: ${line}`);
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { name: string } | undefined;
    if (!table) throw new Error(`Migration directive references missing table ${tableName}`);
    const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === columnName)) {
      database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }
}

export function assertDatabaseIntegrity(database: Database.Database): void {
  const result = database.pragma('quick_check(1)', { simple: true });
  if (result !== 'ok') throw new Error(`SQLite integrity check failed: ${String(result)}`);
}

function assertCurrentSchema(database: Database.Database, includeScanSummaries: boolean): void {
  const requiredTables = includeScanSummaries
    ? CURRENT_SCHEMA_TABLES
    : CURRENT_SCHEMA_TABLES.filter((table) => table !== 'funding_scan_summaries');
  const rows = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (${requiredTables.map(() => '?').join(', ')})
  `).all(...requiredTables) as Array<{ name: string }>;
  const present = new Set(rows.map((row) => row.name));
  const missing = requiredTables.filter((table) => !present.has(table));
  if (missing.length > 0) throw new Error(`Database schema is missing required tables: ${missing.join(', ')}`);
  const auditColumns = database.prepare('PRAGMA table_info(audit_events)').all() as Array<{ name: string }>;
  if (!auditColumns.some((column) => column.name === 'correlation_id')) {
    throw new Error('Database schema is missing audit_events.correlation_id');
  }
}

export function openDatabase(databasePath: string, migrationsDir: string,
  options: OpenDatabaseOptions = {}): Database.Database {
  const onDisk = databasePath !== ':memory:';
  const dataDirectory = dirname(databasePath);
  if (onDisk) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    chmodSync(dataDirectory, 0o700);
  }
  const database = new Database(databasePath);
  if (onDisk) chmodSync(databasePath, 0o600);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('wal_autocheckpoint = 1000');
  // WAL/SHM permissions derive from the owner-only database and restrictive process umask in the
  // production server. Re-assert the main file mode for databases created by older releases.
  if (onDisk) chmodSync(databasePath, 0o600);

  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    const migrationFiles = readdirSync(migrationsDir)
      .filter((filename) => /^\d+.*\.sql$/.test(filename))
      .sort((left, right) => left.localeCompare(right));

    for (const id of migrationFiles) {
      const sql = readFileSync(join(migrationsDir, id), 'utf8');
      const checksums = compatibleMigrationChecksums(sql);
      const checksum = migrationChecksum(sql.replace(/\r\n?/g, '\n'));
      const applied = database
        .prepare('SELECT id, checksum FROM schema_migrations WHERE id = ?')
        .get(id) as AppliedMigration | undefined;

      if (applied) {
        if (!checksums.has(applied.checksum)) {
          throw new Error(`Applied migration ${id} does not match its recorded checksum`);
        }
        continue;
      }

      database.transaction(() => {
        applyMigrationDirectives(database, sql);
        database.exec(sql);
        database
          .prepare('INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)')
          .run(id, checksum, new Date().toISOString());
      })();
    }

    const startupIntegrityMaxBytes = options.startupIntegrityMaxBytes ?? DEFAULT_STARTUP_INTEGRITY_MAX_BYTES;
    // 大库每次重启做全页 quick_check 会把磁盘读满并让网页长时间 502。迁移校验和 schema 检查仍同步执行，
    // 全库完整性检查改到停机维护窗口；小库、内存库和测试库继续在启动时检查。
    if (!onDisk || statSync(databasePath).size <= startupIntegrityMaxBytes) assertDatabaseIntegrity(database);
    if (migrationFiles.includes('0014_database_maintenance.sql')) {
      assertCurrentSchema(database, migrationFiles.includes('0026_funding_scan_summaries.sql'));
    }
    database.pragma('optimize');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function prepareDatabaseForClose(database: Database.Database): void {
  database.pragma('optimize');
  try {
    database.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // In-memory/test databases do not have a WAL file to checkpoint.
  }
}

export function readDatabaseStatus(database: Database.Database): DatabaseStatus {
  try {
    const result = database
      .prepare('SELECT COUNT(*) AS count, MAX(id) AS currentMigration FROM schema_migrations')
      .get() as { count: number; currentMigration: string | null };
    return { state: 'ok', migrationCount: result.count, currentMigration: result.currentMigration };
  } catch {
    return { state: 'error', migrationCount: 0, currentMigration: null };
  }
}
