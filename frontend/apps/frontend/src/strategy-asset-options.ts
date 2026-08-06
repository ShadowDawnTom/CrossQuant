import type { MarketCatalogAsset } from './api.js';

export interface StrategyAssetOption {
  asset: string;
  leftQuote: string;
  rightQuote: string;
  streamed: boolean;
}

export function quoteForStrategyVenue(venueId: string): string {
  return venueId === 'kraken' ? 'USD' : venueId === 'hyperliquid' || venueId === 'deribit' ? 'USDC' : 'USDT';
}

function strategySymbol(venueId: string, asset: string): string {
  return `${venueId.toUpperCase()}_FUTURE_${asset}_${quoteForStrategyVenue(venueId)}`;
}

/** Prefer the exact venue symbol from the catalog because its native ticker may be aliased. */
export function strategyVenueSymbol(
  catalog: MarketCatalogAsset[] | null,
  venueId: string,
  asset: string,
): string {
  return catalog
    ?.find((entry) => entry.asset === asset)
    ?.venues.find((venue) => venue.venue === venueId.toUpperCase())
    ?.symbol
    ?? strategySymbol(venueId, asset);
}

export function strategyAssetOptions(
  catalog: MarketCatalogAsset[] | null,
  fallbackAssets: string[],
  leftVenueId: string,
  rightVenueId: string,
): StrategyAssetOption[] {
  if (catalog === null) {
    return [...new Set(fallbackAssets)].sort().map((asset) => ({
      asset,
      leftQuote: quoteForStrategyVenue(leftVenueId),
      rightQuote: quoteForStrategyVenue(rightVenueId),
      streamed: true,
    }));
  }

  const options: StrategyAssetOption[] = [];
  for (const entry of catalog) {
    const left = entry.venues.find((venue) => venue.venue === leftVenueId.toUpperCase());
    const right = entry.venues.find((venue) => venue.venue === rightVenueId.toUpperCase());
    if (!left || !right) continue;
    options.push({
      asset: entry.asset,
      leftQuote: left.quote,
      rightQuote: right.quote,
      streamed: entry.streamed,
    });
  }
  return options.sort((left, right) => Number(right.streamed) - Number(left.streamed) || left.asset.localeCompare(right.asset));
}

function searchNeedle(value: string): string {
  return value.trim().toUpperCase().split(/[/\s_-]/)[0] ?? '';
}

export function rankStrategyAssetOptions(
  options: StrategyAssetOption[],
  query: string,
  selectedAsset: string,
): StrategyAssetOption[] {
  const needle = searchNeedle(query);
  const score = (option: StrategyAssetOption) => {
    if (!needle) return option.asset === selectedAsset ? 0 : option.streamed ? 1 : 2;
    if (option.asset === needle) return 0;
    if (option.asset.startsWith(needle)) return 1;
    if (option.asset.includes(needle)) return 2;
    return 3;
  };
  return options
    .filter((option) => !needle || option.asset.includes(needle))
    .sort((left, right) => score(left) - score(right) || left.asset.localeCompare(right.asset));
}
