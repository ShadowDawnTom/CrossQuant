import type { AuthenticatedPortfolioSnapshot, TradingSnapshot } from './api.js';
import { parseNumber, symbolParts } from './route-shared.js';

export interface StrategyPositionRow {
  id: string;
  venue: string;
  asset: string;
  quote: string;
  side: 'Long' | 'Short';
  quantity: number;
  value: number;
  entryPrice: number;
  markPrice: number;
  leverage: string | null;
  unrealizedPnl: number;
}

export interface StrategyPositionsView {
  status: 'unavailable' | 'stale' | 'fresh';
  rows: StrategyPositionRow[];
}

function portfolioRows(portfolio: AuthenticatedPortfolioSnapshot): StrategyPositionRow[] {
  return portfolio.snapshot.futuresPositions
    .map((position): StrategyPositionRow | null => {
      const quantity = parseNumber(position.quantity) ?? 0;
      if (quantity === 0) return null;
      const symbol = symbolParts(position.symbol);
      const markPrice = parseNumber(position.markPrice) ?? 0;
      const reportedValue = Math.abs(parseNumber(position.value) ?? 0);
      return {
        id: `${symbol.venue}:${position.positionId || position.symbol}`,
        venue: symbol.venue,
        asset: symbol.asset,
        quote: symbol.quote,
        side: position.positionSide.toUpperCase() === 'SHORT' || quantity < 0 ? 'Short' : 'Long',
        quantity,
        value: reportedValue > 0 ? reportedValue : Math.abs(quantity * markPrice),
        entryPrice: parseNumber(position.entryPrice) ?? 0,
        markPrice,
        leverage: position.leverage || null,
        unrealizedPnl: parseNumber(position.unrealizedPnl) ?? 0,
      };
    })
    .filter((row): row is StrategyPositionRow => row !== null);
}

function executionRows(
  snapshot: TradingSnapshot,
  portfolio: AuthenticatedPortfolioSnapshot | null,
): StrategyPositionRow[] {
  const freshPortfolioPositions = portfolio?.dataStatus === 'fresh' && portfolio.remoteStatus === 'healthy'
    ? portfolio.snapshot.futuresPositions
    : [];

  return snapshot.positions
    .map((position): StrategyPositionRow | null => {
      const quantity = parseNumber(position.quantity) ?? 0;
      if (quantity === 0) return null;
      const symbol = symbolParts(position.symbol);
      const entryPrice = parseNumber(position.entry_price) ?? 0;
      const markPrice = parseNumber(position.mark_price) ?? 0;
      const portfolioPosition = freshPortfolioPositions.find((candidate) =>
        candidate.positionId === position.position_id || candidate.symbol === position.symbol);
      const reportedPnl = portfolioPosition ? parseNumber(portfolioPosition.unrealizedPnl) : null;
      return {
        id: `${symbol.venue}:${position.position_id || position.symbol}`,
        venue: symbol.venue,
        asset: symbol.asset,
        quote: symbol.quote,
        side: quantity < 0 ? 'Short' : 'Long',
        quantity,
        value: Math.abs(quantity * markPrice),
        entryPrice,
        markPrice,
        leverage: portfolioPosition?.leverage || null,
        unrealizedPnl: reportedPnl ?? ((markPrice - entryPrice) * quantity),
      };
    })
    .filter((row): row is StrategyPositionRow => row !== null);
}

function marketKey(row: StrategyPositionRow): string {
  return `${row.venue}:${row.asset}:${row.quote}`;
}

/**
 * Use the same execution-position snapshot shown by the trading page. A healthy portfolio
 * snapshot enriches those rows with leverage and reported PnL and also fills any missing legs.
 */
export function prepareStrategyPositions(
  portfolio: AuthenticatedPortfolioSnapshot | null,
  tradingSnapshot: TradingSnapshot | null = null,
): StrategyPositionsView {
  const portfolioFresh = portfolio?.dataStatus === 'fresh' && portfolio.remoteStatus === 'healthy';
  if (!tradingSnapshot && !portfolio) return { status: 'unavailable', rows: [] };
  if (!tradingSnapshot && !portfolioFresh) return { status: 'stale', rows: [] };

  const rowsByMarket = new Map<string, StrategyPositionRow>();
  if (portfolioFresh && portfolio) {
    for (const row of portfolioRows(portfolio)) rowsByMarket.set(marketKey(row), row);
  }
  if (tradingSnapshot) {
    for (const row of executionRows(tradingSnapshot, portfolio)) rowsByMarket.set(marketKey(row), row);
  }
  const rows = [...rowsByMarket.values()].sort((left, right) => right.value - left.value);

  return { status: 'fresh', rows };
}
