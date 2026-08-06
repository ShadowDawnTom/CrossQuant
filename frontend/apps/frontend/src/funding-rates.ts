export interface AverageFundingRate {
  rate: number | null;
  venueCount: number;
}

/**
 * Build an identity for a set of funding-history symbols. Sorting prevents
 * live market reordering from restarting the same page-wide history load.
 */
export function fundingHistoryRequestKey(symbols: ReadonlyArray<string>): string {
  return [...new Set(symbols)].sort().join('|');
}

/** Keep an explicitly applied sort stable while refreshed row values arrive. */
export function applyFundingAssetOrder<T extends { asset: string }>(
  rows: ReadonlyArray<T>,
  order: ReadonlyArray<string>,
): T[] {
  const rank = new Map(order.map((asset, index) => [asset, index]));
  return [...rows].sort((left, right) => {
    const leftRank = rank.get(left.asset) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.asset) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.asset.localeCompare(right.asset);
  });
}

/** Convert an already-summed realized funding fraction to the percentage shown in the table. */
export function cumulativeFundingPercent(rate: string | null): number | null {
  if (rate === null || rate.trim() === '') return null;
  const value = Number(rate) * 100;
  return Number.isFinite(value) ? value : null;
}

/**
 * Average the normalized funding rates for selected venues where the asset is
 * tradable and a funding quote is available.
 */
export function averageAvailableFundingRate(
  rates: ReadonlyArray<number | null>,
  listed: ReadonlyArray<boolean>,
  venueIndexes: ReadonlyArray<number>,
): AverageFundingRate {
  let total = 0;
  let venueCount = 0;

  for (const index of venueIndexes) {
    const rate = rates[index];
    if (!listed[index] || rate === null || !Number.isFinite(rate)) continue;
    total += rate;
    venueCount += 1;
  }

  return {
    rate: venueCount > 0 ? total / venueCount : null,
    venueCount,
  };
}
