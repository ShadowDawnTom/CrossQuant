import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const databasePath = resolve(process.argv[2] ?? '.local-data/gate-crossex.sqlite');
const iterations = Math.max(100, Math.min(100_000, Number(process.argv[3] ?? 10_000)));
const database = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  const strategy = database.prepare(`
    SELECT strategy_id FROM execution_orders WHERE strategy_id IS NOT NULL LIMIT 1
  `).get();
  const strategyId = strategy?.strategy_id ?? '__benchmark_missing_strategy__';
  const sql = `SELECT strategy_leg AS leg, side, quantity, executed_quantity, strategy_clip, reduce_only
    FROM execution_orders WHERE strategy_id = ? ORDER BY created_at ASC, rowid ASC`;

  const prepared = database.prepare(sql);
  const startedPrepared = performance.now();
  for (let index = 0; index < iterations; index += 1) prepared.all(strategyId);
  const preparedMs = performance.now() - startedPrepared;

  const startedRepeated = performance.now();
  for (let index = 0; index < iterations; index += 1) database.prepare(sql).all(strategyId);
  const repeatedMs = performance.now() - startedRepeated;

  console.log(JSON.stringify({
    iterations,
    cachedPreparedMs: Number(preparedMs.toFixed(2)),
    repeatedPrepareMs: Number(repeatedMs.toFixed(2)),
    cachedOperationsPerSecond: Math.round(iterations / (preparedMs / 1_000)),
  }, null, 2));
} finally {
  database.close();
}
