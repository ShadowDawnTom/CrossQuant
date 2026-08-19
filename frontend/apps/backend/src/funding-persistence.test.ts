import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { persistenceAdjustedRetention, readFundingPersistence } from './funding-persistence.js';

const resources: Array<{ directory: string; database: { close(): void } }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.database.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('funding persistence', () => {
  it('uses only complete realized UTC-day pairs and caps configured retention', () => {
    const directory = mkdtempSync(join(tmpdir(), 'funding-persistence-'));
    const database = openDatabase(join(directory, 'test.sqlite'), resolve(process.cwd(), '../../migrations'));
    resources.push({ directory, database });
    const now = Date.parse('2026-08-19T12:00:00.000Z');
    const insert = database.prepare(`INSERT INTO funding_rate_history (symbol, funding_time, rate, fetched_at)
      VALUES (?, ?, ?, ?)`);
    for (let day = 1; day <= 10; day += 1) {
      const timestamp = now - day * 24 * 60 * 60_000;
      insert.run('GATE_FUTURE_SOL_USDT', timestamp, '0.0001', new Date(now).toISOString());
      insert.run('BINANCE_FUTURE_SOL_USDT', timestamp, day <= 8 ? '0.0003' : '0.00005', new Date(now).toISOString());
    }
    const stats = readFundingPersistence(database, 'GATE_FUTURE_SOL_USDT', 'BINANCE_FUTURE_SOL_USDT', now);
    expect(stats).toMatchObject({ samples: 10, positiveWindows: 8, probability: '0.8', directionFlips: 1 });
    expect(persistenceAdjustedRetention('0.9', stats)).toBe('0.8');
    expect(persistenceAdjustedRetention('0.5', stats)).toBe('0.5');
  });
});
