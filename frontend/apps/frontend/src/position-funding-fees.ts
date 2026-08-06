import type { PortfolioFuturesPosition } from '@gate-crossex/shared-types';

interface PositionReference {
  position_id: string;
  symbol: string;
  funding_fee?: string | null;
}

/** Match the execution row to the authenticated accounting row without guessing between dual-side positions. */
export function positionFundingFee(
  position: PositionReference,
  portfolioPositions: readonly PortfolioFuturesPosition[],
): number | null {
  if (position.funding_fee !== undefined && position.funding_fee !== null && position.funding_fee.trim() !== '') {
    const directValue = Number(position.funding_fee);
    if (Number.isFinite(directValue)) return directValue;
  }
  const exact = portfolioPositions.find((candidate) => candidate.positionId === position.position_id);
  const symbolMatches = exact ? [] : portfolioPositions.filter((candidate) => candidate.symbol === position.symbol);
  const match = exact ?? (symbolMatches.length === 1 ? symbolMatches[0] : undefined);
  if (!match || match.fundingFee.trim() === '') return null;
  const value = Number(match.fundingFee);
  return Number.isFinite(value) ? value : null;
}

export function aggregatePositionFundingFee(
  positions: readonly PositionReference[],
  portfolioPositions: readonly PortfolioFuturesPosition[],
): number | null {
  const values = positions.map((position) => positionFundingFee(position, portfolioPositions));
  return values.every((value): value is number => value !== null)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}
