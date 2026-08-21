import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { FundingOverviewResponse } from '@gate-crossex/shared-types';
import type { GateCrossExSymbol, GateFundingInfo } from './crossex-client.js';
import { LIVE_EXECUTION_VENUES, type ExecutionVenue } from './execution-market-hub.js';

const FUNDING_SYMBOL = /^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_([A-Z0-9]+)_(USD|USDC|USDT)$/;
const EXECUTABLE_VENUES = new Set<string>(LIVE_EXECUTION_VENUES);

export interface FundingDiscoveryAsset {
  asset: string;
  observedAt: string;
  bestLongVenue: ExecutionVenue | null;
  bestShortVenue: ExecutionVenue | null;
  bestLongRate: string | null;
  bestShortRate: string | null;
  spread8h: string | null;
  openInterestUsd: string | null;
  lastPrice: string | null;
  change24h: string | null;
  edgeDurationMinutes: number;
  directionFlips24h: number;
  consecutiveConfirmations: number;
  eligibleForHotPool: boolean;
  inHotPool: boolean;
  primaryReason: string;
  score: number;
  details: Record<string, unknown>;
}

export interface FundingDiscoverySummary {
  updatedAt: string | null;
  universeSize: number;
  hotPoolSize: number;
  hotPoolLimit: number;
  hotAssets: string[];
  eligibleCount: number;
  assets: FundingDiscoveryAsset[];
}

export interface FundingDiscoveryOptions {
  assets: string[];
  initialHotAssets: string[];
  requiredAssets: string[];
  hotPoolSize: number;
  minOpenInterestUsd: string;
  promotionConfirmations: number;
  minEdgeDurationMs: number;
  maxDirectionFlips24h: number;
  snapshotIntervalMs: number;
  minHotDwellMs: number;
  protectedAssets?: () => readonly string[];
  onHotPoolChanged?: (assets: readonly string[]) => void | Promise<void>;
  now?: () => number;
}

interface AssetState {
  direction: string | null;
  edgeStartedAt: number;
  confirmations: number;
  flipEvents: number[];
}

function finiteDecimal(value: string | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : null;
  } catch { return null; }
}

function eightHourRate(row: GateFundingInfo): Decimal | null {
  const rate = finiteDecimal(row.funding_rate);
  const intervalSeconds = Number(row.funding_interval);
  if (!rate || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return null;
  return rate.mul(28_800).div(intervalSeconds);
}

function fundingTimeIso(value: string): string | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : null;
}

function delistTimeMs(rule: GateCrossExSymbol | null | undefined): number | null {
  const parsed = Number(rule?.delist_time);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed < 1_000_000_000_000 ? parsed * 1_000 : parsed;
}

/**
 * 广域发现池只处理分钟级 REST 数据，不读取订单簿。它先用规则、Ticker、持仓量和费率持续性筛选，
 * 再把少量候选交给 WebSocket 热池；因此扩大币种不会线性放大完整盘口内存。
 */
export class FundingDiscoveryService {
  private readonly now: () => number;
  private readonly universe: string[];
  private readonly required: Set<string>;
  private readonly initialHot: string[];
  private readonly states = new Map<string, AssetState>();
  private readonly hotSince = new Map<string, number>();
  private hotAssets: string[];
  private latest: FundingDiscoveryAsset[] = [];
  private updatedAt: string | null = null;
  private lastPersistedAt = 0;

  constructor(private readonly database: Database.Database, private readonly options: FundingDiscoveryOptions) {
    this.now = options.now ?? Date.now;
    this.universe = [...new Set(options.assets.map((item) => item.toUpperCase()))];
    this.required = new Set(options.requiredAssets.map((item) => item.toUpperCase()));
    this.initialHot = [...new Set([...this.required, ...options.initialHotAssets.map((item) => item.toUpperCase())])]
      .filter((item) => this.universe.includes(item)).slice(0, options.hotPoolSize);
    this.hotAssets = [...this.initialHot];
    const now = this.now();
    for (const asset of this.hotAssets) this.hotSince.set(asset, now);
    this.restoreStates(now);
  }

  activeAssets(): readonly string[] { return this.hotAssets; }

  summary(): FundingDiscoverySummary {
    return {
      updatedAt: this.updatedAt,
      universeSize: this.universe.length,
      hotPoolSize: this.hotAssets.length,
      hotPoolLimit: this.options.hotPoolSize,
      hotAssets: [...this.hotAssets],
      eligibleCount: this.latest.filter((item) => item.eligibleForHotPool).length,
      assets: this.latest.slice(0, 100),
    };
  }

  async observe(funding: readonly GateFundingInfo[], rules: readonly GateCrossExSymbol[],
    overview: FundingOverviewResponse | null): Promise<readonly string[]> {
    const now = this.now();
    const observedAt = new Date(now).toISOString();
    const ruleMap = new Map(rules.map((rule) => [rule.symbol, rule]));
    const overviewMap = new Map((overview?.assets ?? []).map((item) => [item.asset, item]));
    const rowsByAsset = new Map<string, GateFundingInfo[]>();
    for (const row of funding) {
      const match = FUNDING_SYMBOL.exec(row.symbol);
      if (!match?.[2] || !this.universe.includes(match[2])) continue;
      const rows = rowsByAsset.get(match[2]) ?? [];
      rows.push(row);
      rowsByAsset.set(match[2], rows);
    }
    const next = this.universe.map((asset) => this.evaluateAsset(
      asset, rowsByAsset.get(asset) ?? [], ruleMap, overviewMap.get(asset) ?? null, now, observedAt,
    )).sort((left, right) => right.score - left.score || left.asset.localeCompare(right.asset));
    await this.updateHotPool(next, now);
    const hot = new Set(this.hotAssets);
    this.latest = next.map((item) => ({ ...item, inHotPool: hot.has(item.asset) }));
    this.updatedAt = observedAt;
    if (now - this.lastPersistedAt >= this.options.snapshotIntervalMs) {
      this.persist(this.latest, observedAt);
      this.lastPersistedAt = now;
    }
    // 常驻种子币可以保留盘口用于观测，但只有通过全部轻量准入条件的热池成员才能交给模拟开仓器。
    return this.latest.filter((item) => item.inHotPool && item.eligibleForHotPool).map((item) => item.asset);
  }

  private evaluateAsset(asset: string, rows: readonly GateFundingInfo[], ruleMap: ReadonlyMap<string, GateCrossExSymbol>,
    overview: FundingOverviewResponse['assets'][number] | null, now: number, observedAt: string): FundingDiscoveryAsset {
    const candidates = rows.flatMap((first, index) => rows.slice(index + 1).flatMap((second) => {
      const firstMatch = FUNDING_SYMBOL.exec(first.symbol);
      const secondMatch = FUNDING_SYMBOL.exec(second.symbol);
      const firstRate = eightHourRate(first);
      const secondRate = eightHourRate(second);
      if (!firstMatch?.[1] || !secondMatch?.[1] || !firstRate || !secondRate) return [];
      const [long, short, longVenue, shortVenue, longRate, shortRate] = firstRate.lte(secondRate)
        ? [first, second, firstMatch[1] as ExecutionVenue, secondMatch[1] as ExecutionVenue, firstRate, secondRate] as const
        : [second, first, secondMatch[1] as ExecutionVenue, firstMatch[1] as ExecutionVenue, secondRate, firstRate] as const;
      return [{ long, short, longVenue, shortVenue, longRate, shortRate, spread: shortRate.minus(longRate) }];
    })).sort((left, right) => right.spread.cmp(left.spread));
    const grossBest = candidates[0] ?? null;
    // 毛差第一名可能来自研究专用交易所或已停止交易的合约；热池必须继续寻找可由真实执行器支持的组合。
    const best = candidates.find((item) => EXECUTABLE_VENUES.has(item.longVenue)
      && EXECUTABLE_VENUES.has(item.shortVenue)
      && ruleMap.get(item.long.symbol)?.state === 'live' && ruleMap.get(item.short.symbol)?.state === 'live')
      ?? grossBest;
    const direction = best ? `${best.longVenue}:${best.shortVenue}` : null;
    const state = this.states.get(asset) ?? { direction: null, edgeStartedAt: now, confirmations: 0, flipEvents: [] };
    if (direction && best?.spread.gt(0)) {
      if (state.direction === direction) state.confirmations += 1;
      else {
        if (state.direction !== null) state.flipEvents.push(now);
        state.direction = direction;
        state.edgeStartedAt = now;
        state.confirmations = 1;
      }
    } else {
      state.direction = direction;
      state.edgeStartedAt = now;
      state.confirmations = 0;
    }
    state.flipEvents = state.flipEvents.filter((timestamp) => now - timestamp <= 24 * 60 * 60_000);
    this.states.set(asset, state);

    const longRule = best ? ruleMap.get(best.long.symbol) : null;
    const shortRule = best ? ruleMap.get(best.short.symbol) : null;
    const venueRows = overview?.venues ?? [];
    const longTicker = best ? venueRows.find((item) => item.symbol === best.long.symbol) : null;
    const shortTicker = best ? venueRows.find((item) => item.symbol === best.short.symbol) : null;
    const longOi = finiteDecimal(longTicker?.openInterestValue);
    const shortOi = finiteDecimal(shortTicker?.openInterestValue);
    const openInterest = longOi && shortOi ? Decimal.min(longOi, shortOi) : null;
    const tickerAge = Math.max(
      longTicker?.fetchedAt ? now - Date.parse(longTicker.fetchedAt) : Number.POSITIVE_INFINITY,
      shortTicker?.fetchedAt ? now - Date.parse(shortTicker.fetchedAt) : Number.POSITIVE_INFINITY,
    );
    const scheduleValid = best ? [best.long, best.short].every((item) =>
      Number.isFinite(Number(item.funding_time)) && Number(item.funding_time) > 0
      && Number.isFinite(Number(item.funding_interval)) && Number(item.funding_interval) > 0) : false;
    const rulesLive = Boolean(longRule && shortRule && longRule.state === 'live' && shortRule.state === 'live');
    const longDelistAt = delistTimeMs(longRule);
    const shortDelistAt = delistTimeMs(shortRule);
    const delistingSoon = [longDelistAt, shortDelistAt].some((timestamp) =>
      timestamp !== null && timestamp <= now + 7 * 24 * 60 * 60_000);
    const executionSupported = Boolean(best && EXECUTABLE_VENUES.has(best.longVenue) && EXECUTABLE_VENUES.has(best.shortVenue));
    const tickerValid = Boolean(longTicker?.lastPrice && shortTicker?.lastPrice && Number.isFinite(tickerAge) && tickerAge <= 10 * 60_000);
    const oiValid = Boolean(openInterest && openInterest.gte(this.options.minOpenInterestUsd));
    const reason = !best || !best.spread.gt(0) ? 'discovery_funding_edge_missing'
      : !longRule || !shortRule ? 'instrument_rule_missing'
        : !rulesLive || delistingSoon ? 'instrument_not_live_or_delisting'
          : !executionSupported ? 'executor_venue_not_supported'
            : !scheduleValid ? 'funding_schedule_unavailable'
              : !longTicker || !shortTicker ? 'discovery_ticker_missing'
                : !tickerValid ? 'discovery_ticker_stale'
                  : !longOi || !shortOi ? 'discovery_open_interest_missing'
                    : !oiValid ? 'discovery_open_interest_below_threshold'
                      : state.flipEvents.length > this.options.maxDirectionFlips24h ? 'discovery_direction_flips_exceeded'
                        : now - state.edgeStartedAt < this.options.minEdgeDurationMs ? 'discovery_edge_duration_insufficient'
                          : state.confirmations < this.options.promotionConfirmations ? 'discovery_persistence_pending'
                        : 'discovery_hot_pool_eligible';
    const eligible = reason === 'discovery_hot_pool_eligible';
    const oiScore = openInterest?.gt(0) ? Math.min(20, Math.log10(openInterest.toNumber()) * 2) : 0;
    const score = best ? best.spread.mul(10_000).toNumber() + Math.min(20, state.confirmations) + oiScore : -1;
    return {
      asset, observedAt, bestLongVenue: best?.longVenue ?? null, bestShortVenue: best?.shortVenue ?? null,
      bestLongRate: best?.longRate.toString() ?? null, bestShortRate: best?.shortRate.toString() ?? null,
      spread8h: best?.spread.toString() ?? null, openInterestUsd: openInterest?.toString() ?? null,
      lastPrice: longTicker?.lastPrice ?? shortTicker?.lastPrice ?? null,
      change24h: longTicker?.change24h ?? shortTicker?.change24h ?? null,
      edgeDurationMinutes: state.confirmations > 0 ? Math.max(0, Math.floor((now - state.edgeStartedAt) / 60_000)) : 0,
      directionFlips24h: state.flipEvents.length, consecutiveConfirmations: state.confirmations,
      eligibleForHotPool: eligible, inHotPool: this.hotAssets.includes(asset), primaryReason: reason, score,
      details: {
        longSymbol: best?.long.symbol ?? null, shortSymbol: best?.short.symbol ?? null,
        grossBestLongVenue: grossBest?.longVenue ?? null, grossBestShortVenue: grossBest?.shortVenue ?? null,
        grossBestSpread8h: grossBest?.spread.toString() ?? null,
        longFundingIntervalSeconds: best?.long.funding_interval ?? null,
        shortFundingIntervalSeconds: best?.short.funding_interval ?? null,
        longNextFundingAt: best ? fundingTimeIso(best.long.funding_time) : null,
        shortNextFundingAt: best ? fundingTimeIso(best.short.funding_time) : null,
        longTicker, shortTicker,
        longRule: longRule ? { state: longRule.state, lotSize: longRule.lot_size, minSize: longRule.min_size,
          minNotional: longRule.min_notional, maxMarketSize: longRule.max_market_size,
          delistAt: longDelistAt === null ? null : new Date(longDelistAt).toISOString() } : null,
        shortRule: shortRule ? { state: shortRule.state, lotSize: shortRule.lot_size, minSize: shortRule.min_size,
          minNotional: shortRule.min_notional, maxMarketSize: shortRule.max_market_size,
          delistAt: shortDelistAt === null ? null : new Date(shortDelistAt).toISOString() } : null,
        tickerAgeMs: Number.isFinite(tickerAge) ? tickerAge : null, scheduleValid, executionSupported, delistingSoon,
      },
    };
  }

  private async updateHotPool(rows: readonly FundingDiscoveryAsset[], now: number): Promise<void> {
    const protectedAssets = new Set([
      ...this.required,
      ...(this.options.protectedAssets?.() ?? []).map((item) => item.toUpperCase()),
    ]);
    const selected: string[] = [];
    const add = (asset: string): void => {
      if (this.universe.includes(asset) && !selected.includes(asset) && selected.length < this.options.hotPoolSize) selected.push(asset);
    };
    protectedAssets.forEach(add);
    // 最短驻留时间防止费率噪声每分钟触发全所订阅抖动。
    for (const asset of this.hotAssets) {
      if (now - (this.hotSince.get(asset) ?? 0) < this.options.minHotDwellMs) add(asset);
    }
    rows.filter((item) => item.eligibleForHotPool).forEach((item) => add(item.asset));
    this.initialHot.forEach(add);
    if (selected.join(',') === this.hotAssets.join(',')) return;
    const previous = new Set(this.hotAssets);
    this.hotAssets = selected;
    for (const asset of selected) if (!previous.has(asset)) this.hotSince.set(asset, now);
    for (const asset of [...this.hotSince.keys()]) if (!selected.includes(asset)) this.hotSince.delete(asset);
    await this.options.onHotPoolChanged?.(selected);
  }

  private persist(rows: readonly FundingDiscoveryAsset[], observedAt: string): void {
    const sweepId = randomUUID();
    const statement = this.database.prepare(`INSERT INTO funding_discovery_snapshots
      (id, sweep_id, observed_at, asset, best_long_venue, best_short_venue, best_long_rate, best_short_rate,
       spread_8h, open_interest_usd, last_price, change_24h, edge_started_at, direction_flips_24h,
       consecutive_confirmations, eligible_for_hot_pool, in_hot_pool, primary_reason, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.database.transaction(() => {
      for (const row of rows) statement.run(randomUUID(), sweepId, observedAt, row.asset, row.bestLongVenue,
        row.bestShortVenue, row.bestLongRate, row.bestShortRate, row.spread8h, row.openInterestUsd,
        row.lastPrice, row.change24h,
        row.consecutiveConfirmations > 0 ? new Date(Date.parse(observedAt) - row.edgeDurationMinutes * 60_000).toISOString() : null,
        row.directionFlips24h, row.consecutiveConfirmations, row.eligibleForHotPool ? 1 : 0,
        row.inHotPool ? 1 : 0, row.primaryReason, JSON.stringify(row.details));
    })();
  }

  private restoreStates(now: number): void {
    const cutoff = new Date(now - 24 * 60 * 60_000).toISOString();
    const rows = this.database.prepare(`SELECT asset, observed_at, best_long_venue, best_short_venue, edge_started_at
      FROM funding_discovery_snapshots WHERE observed_at >= ? ORDER BY asset, observed_at`).all(cutoff) as Array<{
        asset: string; observed_at: string; best_long_venue: string | null; best_short_venue: string | null;
        edge_started_at: string | null;
      }>;
    for (const row of rows) {
      const direction = row.best_long_venue && row.best_short_venue ? `${row.best_long_venue}:${row.best_short_venue}` : null;
      const state = this.states.get(row.asset) ?? { direction: null, edgeStartedAt: now, confirmations: 0, flipEvents: [] };
      if (state.direction !== null && direction !== null && state.direction !== direction) state.flipEvents.push(Date.parse(row.observed_at));
      state.direction = direction;
      state.edgeStartedAt = row.edge_started_at ? Date.parse(row.edge_started_at) : Date.parse(row.observed_at);
      this.states.set(row.asset, state);
    }
  }
}
