export interface MarketAssetAlias {
  venue: string;
  businessType: string;
  nativeAsset: string;
  canonicalAsset: string;
}

/**
 * Version-controlled identity aliases for venue tickers that name the same underlying asset
 * differently. Keep these scoped by venue and product so similarly named instruments elsewhere
 * are never merged accidentally.
 */
export const MARKET_ASSET_ALIASES = [
  {
    venue: 'HYPERLIQUID',
    businessType: 'FUTURE',
    nativeAsset: 'SKHX',
    canonicalAsset: 'SKHYNIX',
  },
] as const satisfies readonly MarketAssetAlias[];

function aliasKey(venue: string, businessType: string, asset: string): string {
  return `${venue.toUpperCase()}:${businessType.toUpperCase()}:${asset.toUpperCase()}`;
}

const canonicalByNative = new Map<string, string>();
const nativeByCanonical = new Map<string, string>();

for (const alias of MARKET_ASSET_ALIASES) {
  const nativeKey = aliasKey(alias.venue, alias.businessType, alias.nativeAsset);
  const canonicalKey = aliasKey(alias.venue, alias.businessType, alias.canonicalAsset);
  if (canonicalByNative.has(nativeKey)) throw new Error(`Duplicate market asset alias: ${nativeKey}`);
  if (nativeByCanonical.has(canonicalKey)) throw new Error(`Ambiguous market asset routing alias: ${canonicalKey}`);
  canonicalByNative.set(nativeKey, alias.canonicalAsset);
  nativeByCanonical.set(canonicalKey, alias.nativeAsset);
}

/** Resolve an exchange-native asset code to the identity used to group markets in the UI/API. */
export function canonicalMarketAsset(venue: string, businessType: string, nativeAsset: string): string {
  return canonicalByNative.get(aliasKey(venue, businessType, nativeAsset)) ?? nativeAsset;
}

/** Resolve a canonical asset identity back to the native code required in an executable symbol. */
export function nativeMarketAsset(venue: string, businessType: string, canonicalAsset: string): string {
  return nativeByCanonical.get(aliasKey(venue, businessType, canonicalAsset)) ?? canonicalAsset;
}
