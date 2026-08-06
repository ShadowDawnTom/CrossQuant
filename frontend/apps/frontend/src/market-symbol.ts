export type MarketProduct = 'perpetual' | 'spot';

interface VenueQuote {
  venue: string;
  quote: string;
}

/**
 * User-facing crypto symbols follow the common exchange convention:
 * derivatives concatenate the pair, while spot markets keep the slash.
 */
export function marketSymbol(base: string, quote: string, product: MarketProduct): string {
  return product === 'spot' ? `${base}/${quote}` : `${base}${quote}`;
}

/** Resolve the quote that selecting an asset will actually trade on the preferred venue. */
export function marketQuoteForVenue(
  venues: readonly VenueQuote[],
  preferredVenue: string,
  fallback = 'USDT',
): string {
  return venues.find((venue) => venue.venue === preferredVenue)?.quote
    ?? venues[0]?.quote
    ?? fallback;
}
