import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { GateCredentials } from './credential-vault.js';
import type { GateAccountBookRecord, GateFeeRate, GateFundingInfo, PortfolioOperationsCrossExGateway } from './crossex-client.js';
import type { FundingArbitrageEngine, FundingLedgerRecord } from './funding-arbitrage-engine.js';

const FUTURE_SYMBOL = /^(GATE|BINANCE|OKX|BYBIT)_FUTURE_([A-Z0-9]+)_USDT$/;

function feeFor(fees: readonly GateFeeRate[], venue: string, symbol: string): string | null {
  const row = fees.find((item) => item.exchange_type === venue);
  if (!row) return null;
  return row.special_fee_list?.find((item) => item.symbol === symbol)?.taker_fee_rate ?? row.future_taker_fee;
}

function isoTimestamp(value: string): string | null {
  const numeric = Number(value);
  // CrossEx 当前示例是毫秒；兼容少数上游把 Unix 秒作为字符串返回，避免被解析成 1970 年。
  const timestamp = Number.isFinite(numeric) && numeric > 0
    ? (numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric)
    : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/**
 * 复用候选扫描器刚取得的认证资金费快照，避免为持仓监控额外占用 funding_info 限频。
 * 每轮先持久化快照，再评估所有 OPEN 组合，最后用账户流水幂等对账实际结算。
 */
export class FundingHoldingMonitor {
  private active: Promise<number> | null = null;
  private lastEvaluationAt = 0;

  constructor(
    private readonly database: Database.Database,
    private readonly gateway: Partial<PortfolioOperationsCrossExGateway>,
    private readonly credentials: () => Promise<GateCredentials | null>,
    private readonly engine: FundingArbitrageEngine,
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  observe(funding: readonly GateFundingInfo[], fees: readonly GateFeeRate[]): Promise<number> {
    if (this.active) return this.active;
    this.active = this.run(funding, fees).finally(() => { this.active = null; });
    return this.active;
  }

  private saveFundingSnapshots(funding: readonly GateFundingInfo[], observedAt: string): void {
    const insert = this.database.prepare(`INSERT OR IGNORE INTO funding_rate_snapshots
      (symbol, funding_rate, funding_time, funding_interval, observed_at) VALUES (?, ?, ?, ?, ?)`);
    this.database.transaction(() => {
      for (const row of funding) {
        const fundingTime = Number(row.funding_time);
        const fundingInterval = Number(row.funding_interval);
        if (!Number.isFinite(fundingTime) || fundingTime <= 0 || !Number.isFinite(fundingInterval) || fundingInterval <= 0) continue;
        insert.run(row.symbol, row.funding_rate, fundingTime, fundingInterval, observedAt);
      }
    })();
  }

  private normalizeLedger(records: readonly GateAccountBookRecord[]): FundingLedgerRecord[] {
    return records.flatMap((record) => {
      const createdAt = isoTimestamp(record.create_time);
      const normalizedSymbol = record.symbol?.toUpperCase();
      if (!createdAt || !normalizedSymbol || !FUTURE_SYMBOL.test(normalizedSymbol)) return [];
      try { new Decimal(record.change); } catch { return []; }
      return [{ id: record.id, symbol: normalizedSymbol, venue: record.exchange_type.toUpperCase(),
        change: record.change, createdAt }];
    });
  }

  private async run(funding: readonly GateFundingInfo[], fees: readonly GateFeeRate[]): Promise<number> {
    const currentTime = this.now();
    const observedAt = new Date(currentTime).toISOString();
    this.saveFundingSnapshots(funding, observedAt);
    // 扫描频率可独立调整；快照仍每轮保存，但持仓判断不能因定时器抖动被重复累计确认次数。
    if (currentTime - this.lastEvaluationAt < this.intervalMs) return 0;
    this.lastEvaluationAt = currentTime;
    const bySymbol = new Map(funding.map((row) => [row.symbol, row]));
    const open = this.engine.list(500).filter((trade) => trade.state === 'OPEN');
    let evaluated = 0;
    for (const trade of open) {
      const longSymbol = `${trade.longVenue}_FUTURE_${trade.asset}_USDT`;
      const shortSymbol = `${trade.shortVenue}_FUTURE_${trade.asset}_USDT`;
      const long = bySymbol.get(longSymbol);
      const short = bySymbol.get(shortSymbol);
      const longFee = feeFor(fees, trade.longVenue, longSymbol);
      const shortFee = feeFor(fees, trade.shortVenue, shortSymbol);
      if (!long || !short || longFee === null || shortFee === null) {
        await this.engine.markHoldingDataUnavailable(trade.id, 'funding_or_fee_missing', {
          longFunding: Boolean(long), shortFunding: Boolean(short), longFee: longFee !== null, shortFee: shortFee !== null,
        });
        continue;
      }
      await this.engine.evaluateOpenTrade(trade.id, { observedAt,
        long: { fundingRate: long.funding_rate, fundingTime: long.funding_time,
          fundingInterval: long.funding_interval, takerFeeRate: longFee },
        short: { fundingRate: short.funding_rate, fundingTime: short.funding_time,
          fundingInterval: short.funding_interval, takerFeeRate: shortFee } });
      evaluated += 1;
    }

    const pending = this.database.prepare("SELECT COUNT(*) AS count FROM funding_expected_settlements WHERE state = 'PENDING'")
      .get() as { count: number };
    if ((open.length > 0 || pending.count > 0) && this.gateway.queryAccountBook) {
      const credentials = await this.credentials();
      if (credentials) {
        const records = await this.gateway.queryAccountBook(credentials, { coin: 'USDT', statementType: 'FUNDING_FEE', limit: 200 });
        await this.engine.reconcileFundingLedger(this.normalizeLedger(records));
      }
    }
    return evaluated;
  }
}
