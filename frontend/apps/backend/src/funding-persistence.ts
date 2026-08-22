import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';

export interface FundingPersistenceStats {
  probability: string | null;
  samples: number;
  positiveWindows: number;
  directionFlips: number;
  medianEdge: string | null;
  p10Edge: string | null;
  horizons?: FundingPersistenceHorizon[];
}

export interface FundingPersistenceHorizon {
  hours: 24 | 72 | 168;
  samples: number;
  survivalProbability: string | null;
  positiveCumulativeProbability: string | null;
  meanEdge: string | null;
  p10Edge: string | null;
}

interface FundingHistoryRow {
  symbol: string;
  funding_time: number;
  rate: string;
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function percentile(values: readonly Decimal[], probability: number): Decimal | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left.cmp(right));
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * probability)));
  return sorted[index] ?? null;
}

function consecutive(left: string, right: string): boolean {
  return Date.parse(`${right}T00:00:00.000Z`) - Date.parse(`${left}T00:00:00.000Z`) === 24 * 60 * 60_000;
}

/** 多日窗口同时统计累计为正和每天方向都不翻转；后者才是可用于续持的生存概率。 */
function horizonStats(days: readonly string[], edges: readonly Decimal[], hours: 24 | 72 | 168): FundingPersistenceHorizon {
  const width = hours / 24;
  const windows: Array<{ total: Decimal; survived: boolean }> = [];
  for (let index = 0; index + width <= edges.length; index += 1) {
    const windowDays = days.slice(index, index + width);
    if (windowDays.slice(1).some((day, offset) => !consecutive(windowDays[offset]!, day))) continue;
    const windowEdges = edges.slice(index, index + width);
    windows.push({
      total: windowEdges.reduce((total, edge) => total.plus(edge), new Decimal(0)),
      survived: windowEdges.every((edge) => edge.gt(0)),
    });
  }
  const positive = windows.filter((window) => window.total.gt(0)).length;
  const survived = windows.filter((window) => window.survived).length;
  const totals = windows.map((window) => window.total);
  return {
    hours,
    samples: windows.length,
    survivalProbability: windows.length === 0 ? null : new Decimal(survived).div(windows.length).toString(),
    positiveCumulativeProbability: windows.length === 0 ? null : new Decimal(positive).div(windows.length).toString(),
    meanEdge: windows.length === 0 ? null
      : totals.reduce((total, edge) => total.plus(edge), new Decimal(0)).div(windows.length).toString(),
    p10Edge: percentile(totals, 0.1)?.toString() ?? null,
  };
}

/**
 * 用两条腿已落库的真实结算费率构造完整 UTC 日窗口。
 * 只比较两边都有数据的完整历史日，避免接口缺数被误判成零费率。
 */
export function readFundingPersistence(
  database: Database.Database,
  longSymbol: string,
  shortSymbol: string,
  nowMs: number,
  lookbackDays = 30,
): FundingPersistenceStats {
  const from = nowMs - lookbackDays * 24 * 60 * 60_000;
  const rows = database.prepare(`SELECT symbol, funding_time, rate FROM funding_rate_history
    WHERE symbol IN (?, ?) AND funding_time >= ? AND funding_time < ? ORDER BY funding_time`)
    .all(longSymbol, shortSymbol, from, nowMs) as FundingHistoryRow[];
  const currentDay = utcDay(nowMs);
  const longDays = new Map<string, Decimal>();
  const shortDays = new Map<string, Decimal>();
  for (const row of rows) {
    const day = utcDay(row.funding_time);
    if (day === currentDay) continue;
    const target = row.symbol === longSymbol ? longDays : row.symbol === shortSymbol ? shortDays : null;
    if (!target) continue;
    target.set(day, (target.get(day) ?? new Decimal(0)).plus(row.rate));
  }
  const days = [...longDays.keys()].filter((day) => shortDays.has(day)).sort();
  const edges = days.map((day) => shortDays.get(day)!.minus(longDays.get(day)!));
  const positiveWindows = edges.filter((edge) => edge.gt(0)).length;
  let directionFlips = 0;
  let previousSign = 0;
  for (const edge of edges) {
    const sign = edge.cmp(0);
    if (sign !== 0 && previousSign !== 0 && sign !== previousSign) directionFlips += 1;
    if (sign !== 0) previousSign = sign;
  }
  const median = percentile(edges, 0.5);
  const p10 = percentile(edges, 0.1);
  return {
    probability: edges.length === 0 ? null : new Decimal(positiveWindows).div(edges.length).toString(),
    samples: edges.length,
    positiveWindows,
    directionFlips,
    medianEdge: median?.toString() ?? null,
    p10Edge: p10?.toString() ?? null,
    horizons: ([24, 72, 168] as const).map((hours) => horizonStats(days, edges, hours)),
  };
}

/** 历史样本不足时沿用人工上限；样本足够后只允许历史命中率把收益折扣得更低。 */
export function persistenceAdjustedRetention(
  configured: string,
  stats: FundingPersistenceStats,
  minimumSamples = 7,
): string {
  if (stats.samples < minimumSamples || stats.probability === null) return configured;
  return Decimal.min(configured, Decimal.max(0, stats.probability)).toString();
}
