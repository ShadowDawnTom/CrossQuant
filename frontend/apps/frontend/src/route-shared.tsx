/* Shared route primitives intentionally combine hooks, render helpers, and constants. */
/* eslint-disable react-refresh/only-export-components */
import { useLayoutEffect, useRef } from 'react';
import type { AuthenticatedPortfolioSnapshot, CandleInterval, CrossExInstrument, LiveBalance, LiveMarket, MarketSnapshot, StrategyConfig } from './api.js';
import { exchangeLogoFor, type ExchangeLogoId } from './exchange-logos.js';
import { compactPrice } from './number-format.js';

export type Side = 'Buy' | 'Sell';
export type OrderType = 'Limit' | 'Market';
export type Workspace = 'Trade' | 'Strategy' | 'Funding Rates' | 'Portfolio';
export type StrategyKind = StrategyConfig['kind'];
export type FundingMetric = 'Per interval' | 'APR' | '24h' | '7d' | '30d';
export type FundingSortKey = 'asset' | 'oi' | 'arb' | 'average' | 'gate' | 'binance' | 'okx' | 'bybit' | 'kraken' | 'hyperliquid' | 'deribit';
export type SortDirection = 'asc' | 'desc';

export interface PairedPositionPrefill {
  asset: string;
  longVenue: ExchangeLogoId;
  shortVenue: ExchangeLogoId;
}

export const DIALOG_FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Keep keyboard focus inside a modal and restore it to the invoking control when the modal closes. */
export function useDialogFocus(open: boolean, onClose?: () => void) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const initialFocus = dialog.querySelector<HTMLElement>('[data-dialog-autofocus]')
      ?? dialog.querySelector<HTMLElement>(DIALOG_FOCUSABLE)
      ?? dialog;
    initialFocus.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onCloseRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)]
        .filter((element) => !element.hasAttribute('disabled') && element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  return dialogRef;
}

/** Friendly names and glyphs for well-known assets; anything else falls back to its code. */
export const ASSET_NAMES: Record<string, string> = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'XRP', DOGE: 'Dogecoin',
  SUI: 'Sui', PEPE: 'Pepe', AAVE: 'Aave', LINK: 'Chainlink', ARB: 'Arbitrum',
};
export const ASSET_ICONS: Record<string, string> = {
  BTC: '₿', ETH: 'Ξ', SOL: 'S', XRP: 'X', DOGE: 'Ð', SUI: 'S', PEPE: 'P', AAVE: 'A', LINK: 'L', ARB: 'A',
};
export const SEED_ASSETS = Object.keys(ASSET_NAMES);

export function assetName(asset: string): string { return ASSET_NAMES[asset] ?? asset; }
export function assetIcon(asset: string): string { return ASSET_ICONS[asset] ?? asset.slice(0, 1); }

export const exchanges = [
  { id: 'gate', name: 'Gate.io', short: 'GT' },
  { id: 'binance', name: 'Binance', short: 'BN' },
  { id: 'okx', name: 'OKX', short: 'OK' },
  { id: 'bybit', name: 'Bybit', short: 'BY' },
  { id: 'kraken', name: 'Kraken', short: 'KR' },
  { id: 'hyperliquid', name: 'Hyperliquid', short: 'HL' },
  { id: 'deribit', name: 'Deribit', short: 'DR' },
] as const satisfies ReadonlyArray<{ id: ExchangeLogoId; name: string; short: string }>;

export const FUNDING_VENUE_COLORS: Record<string, string> = {
  GATE: '#18d6ad',
  BINANCE: '#f0b83f',
  OKX: '#dbe3eb',
  BYBIT: '#f39a2d',
  KRAKEN: '#8d74f5',
  HYPERLIQUID: '#35c9bc',
  DERIBIT: '#54a7d8',
};

export function fundingVenueName(venue: string): string {
  return exchanges.find((entry) => entry.id === venue.toLowerCase())?.name ?? venue;
}

export function streamedAssets(snapshot: MarketSnapshot | null): string[] {
  const seen = new Set<string>();
  for (const market of snapshot?.markets ?? []) seen.add(market.asset);
  if (seen.size === 0) return SEED_ASSETS;
  return [...seen].sort((left, right) =>
    (SEED_ASSETS.includes(right) ? 1 : 0) - (SEED_ASSETS.includes(left) ? 1 : 0) || left.localeCompare(right));
}

export function quoteFor(venueId: string): string {
  return venueId === 'kraken' ? 'USD' : venueId === 'hyperliquid' || venueId === 'deribit' ? 'USDC' : 'USDT';
}

export function crossExSymbol(venueId: string, asset: string): string {
  return `${venueId.toUpperCase()}_FUTURE_${asset}_${quoteFor(venueId)}`;
}

export function liveMarketFor(snapshot: MarketSnapshot | null, exchangeId: string, asset: string): LiveMarket | null {
  return snapshot?.markets.find((item) => item.venue === exchangeId.toUpperCase() && item.asset === asset) ?? null;
}

export function symbolParts(symbol: string) {
  const parts = symbol.split('_');
  return { venue: parts[0] ?? '', asset: parts[2] ?? symbol, quote: parts[3] ?? 'USDT' };
}

export function signedPortfolioQuantity(position: { positionSide: string; quantity: string } | undefined): number {
  if (!position) return 0;
  const rawQuantity = Number(position.quantity) || 0;
  const positionSide = position.positionSide.toUpperCase();
  if (positionSide === 'SHORT') return -Math.abs(rawQuantity);
  if (positionSide === 'LONG') return Math.abs(rawQuantity);
  return rawQuantity;
}

export function incrementalExposure(existingQuantity: number, plannedQuantity: number): number {
  return Math.max(0, Math.abs(existingQuantity + plannedQuantity) - Math.abs(existingQuantity));
}

export function usesSharedCrossExMargin(portfolio: AuthenticatedPortfolioSnapshot | null): boolean {
  return portfolio?.snapshot.account.accountMode === 'CROSS_EXCHANGE';
}

export function balanceFor(balances: Record<string, LiveBalance>, portfolio: AuthenticatedPortfolioSnapshot | null, venueId: string): string | null {
  if (usesSharedCrossExMargin(portfolio)) return portfolio?.snapshot.account.availableMargin ?? null;
  if (portfolio?.snapshot.account.accountMode === 'ISOLATED_EXCHANGE') {
    return portfolio.snapshot.account.exchangeType.toUpperCase() === venueId.toUpperCase()
      ? portfolio.snapshot.account.availableMargin
      : null;
  }
  const quote = quoteFor(venueId);
  const streamed = balances[`${venueId.toUpperCase()}:${quote}`] ?? balances[`CROSSEX:${quote}`] ?? balances[`CROSSEX:USDT`];
  if (streamed) return streamed.availableBalance;
  const fromPortfolio = portfolio?.snapshot.balances.find((balance) => balance.venue === venueId.toUpperCase() && balance.coin === quote)?.availableBalance
    ?? portfolio?.snapshot.balances.find((balance) => balance.venue === 'CROSSEX' && balance.coin === 'USDT')?.availableBalance;
  return fromPortfolio ?? null;
}

export function balanceUnitFor(portfolio: AuthenticatedPortfolioSnapshot | null, venueId: string): string {
  return usesSharedCrossExMargin(portfolio) ? 'USDT' : quoteFor(venueId);
}

export interface MarginCapacityLeg {
  venue: string;
  required: number;
  available: number | null;
}

/**
 * Cross-exchange mode has one authoritative USDT margin balance. Venue asset rows are allocation
 * details and must never cap a leg. Isolated mode instead compares each venue's grouped requirement
 * with the top-level available margin returned for that venue account.
 */
export function assessMarginCapacity(
  accountMode: string | undefined,
  aggregateAvailable: number | null,
  legs: MarginCapacityLeg[],
): { known: boolean; insufficient: boolean } {
  const aggregateKnown = aggregateAvailable !== null && Number.isFinite(aggregateAvailable);
  if (accountMode === 'CROSS_EXCHANGE' || (accountMode === undefined && aggregateKnown)) {
    const required = legs.reduce((sum, leg) => sum + leg.required, 0);
    return { known: aggregateKnown, insufficient: aggregateKnown && required > aggregateAvailable };
  }

  const grouped = new Map<string, { required: number; available: number | null }>();
  for (const leg of legs) {
    const current = grouped.get(leg.venue);
    grouped.set(leg.venue, {
      required: (current?.required ?? 0) + leg.required,
      available: current?.available ?? leg.available,
    });
  }
  const entries = [...grouped.values()];
  const known = entries.length > 0
    && entries.every((entry) => entry.available !== null && Number.isFinite(entry.available));
  const insufficient = entries.some((entry) => entry.available !== null
    && Number.isFinite(entry.available) && entry.required > entry.available);
  return { known, insufficient };
}

export const navItems: { label: Workspace; glyph: string }[] = [
  { label: 'Trade', glyph: '⌁' }, { label: 'Strategy', glyph: '⇄' }, { label: 'Funding Rates', glyph: '%' },
  { label: 'Portfolio', glyph: '◒' },
];

/** Strategies listed under the nav "Strategy" dropdown; each opens its own dedicated page. */
export const strategyPages: Array<{ kind: StrategyKind; glyph: string; label: string; detail: string }> = [
  { kind: 'position', glyph: '◎', label: 'Cross-exchange hedge', detail: 'Execute a fixed two-venue position, then stop' },
  { kind: 'premium', glyph: '≒', label: 'SK hynix premium bot', detail: 'Trade the SK hynix ADR premium vs the Korean listing' },
];

/** SK hynix ADR premium pair: one Korean-listed share converts to ten US ADR shares. */
export const ADR_ASSET = 'SKHY';
export const ADR_HEDGE_ASSET = 'SKHYNIX';
export const DEFAULT_ADR_RATIO = '10';

export type PairHistoryRange = '1H' | '4H' | '24H';
export const PAIR_HISTORY_RANGES: Record<PairHistoryRange, { interval: CandleInterval; durationMs: number }> = {
  '1H': { interval: '1m', durationMs: 60 * 60_000 },
  '4H': { interval: '1m', durationMs: 4 * 60 * 60_000 },
  '24H': { interval: '5m', durationMs: 24 * 60 * 60_000 },
};

export const TIMEFRAMES: Array<{ label: string; interval: CandleInterval }> = [
  { label: '1m', interval: '1m' }, { label: '5m', interval: '5m' }, { label: '15m', interval: '15m' },
  { label: '1H', interval: '1h' }, { label: '4H', interval: '4h' }, { label: '1D', interval: '1d' },
];

/** Prices render as an em dash until real data exists — never a fake zero. */
export function priceText(price: number): string {
  return price > 0 ? compactPrice(price) : '—';
}

/** Grouped amount with a decimal cap; sub-1 magnitudes keep more precision so dust stays visible. */
export function formatAmount(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  return value.toLocaleString('en-US', { maximumFractionDigits: abs > 0 && abs < 1 ? Math.max(digits, 6) : digits });
}

export function signedAmount(value: number, digits = 2): string {
  return `${value >= 0 ? '+' : '-'}${formatAmount(Math.abs(value), digits)}`;
}

/** Venue payloads carry numbers as strings; empty or malformed values must read as absent, not 0. */
export function parseNumber(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Order states counted as resting. Must match trading-runtime and strategy-engine open-state lists. */
export const OPEN_ORDER_STATES = ['PENDING_SUBMIT', 'OPEN', 'NEW', 'PARTIALLY_FILLED'];

export function formatCountdown(target: string | undefined, now: number): string {
  if (!target) return '—';
  const remaining = Date.parse(target) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return '00:00:00';
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
  const minutes = Math.floor((totalSeconds / 60) % 60).toString().padStart(2, '0');
  const seconds = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

export const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

export function isPositiveDecimal(text: string): boolean {
  return DECIMAL_PATTERN.test(text.trim()) && Number(text) > 0;
}

export function decimalScale(text: string): number {
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

export function scaledBigInt(text: string, scale: number): bigint {
  const [whole = '0', fraction = ''] = text.trim().split('.');
  return BigInt(`${whole}${fraction.padEnd(scale, '0').slice(0, scale)}` || '0');
}

/** Exchange step checks need integer math — float remainders split exact multiples. */
export function isMultipleOfStep(value: string, step: string | null): boolean {
  if (!step || !isPositiveDecimal(step)) return true;
  const scale = Math.max(decimalScale(value.trim()), decimalScale(step.trim()));
  const stepScaled = scaledBigInt(step, scale);
  if (stepScaled === 0n) return true;
  return scaledBigInt(value, scale) % stepScaled === 0n;
}

export function floorToStep(value: number, step: string | null): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  if (!step || !isPositiveDecimal(step)) return String(value);
  const units = Math.floor(value / Number(step) + 1e-9);
  if (units <= 0) return '';
  return (units * Number(step)).toFixed(decimalScale(step.trim()));
}

export interface TicketInput {
  orderType: OrderType;
  price: string;
  amount: string;
  referencePrice: number;
  quote: string;
  instrument: CrossExInstrument | null;
  t: (key: string) => string;
}

export function ticketIssues({ orderType, price, amount, referencePrice, quote, instrument, t }: TicketInput): string[] {
  const issues: string[] = [];
  if (!isPositiveDecimal(amount)) issues.push(t('Enter a valid amount'));
  if (orderType === 'Limit' && !isPositiveDecimal(price)) issues.push(t('Enter a valid price'));
  if (issues.length > 0 || !instrument) return issues;
  if (isPositiveDecimal(instrument.minSize) && Number(amount) < Number(instrument.minSize)) {
    issues.push(`${t('Below minimum size')}: ${instrument.minSize}`);
  } else if (!isMultipleOfStep(amount, instrument.lotSize)) {
    issues.push(`${t('Amount not a multiple of lot size')} (${instrument.lotSize})`);
  }
  if (orderType === 'Limit' && !isMultipleOfStep(price, instrument.tickSize)) {
    issues.push(`${t('Price not a multiple of tick size')} (${instrument.tickSize})`);
  }
  const sizeCap = orderType === 'Market' ? instrument.maxMarketSize : instrument.maxLimitSize;
  if (sizeCap && isPositiveDecimal(sizeCap) && Number(amount) > Number(sizeCap)) {
    issues.push(`${t('Above maximum order size')}: ${sizeCap}`);
  }
  if (instrument.minNotional && isPositiveDecimal(instrument.minNotional)) {
    const reference = orderType === 'Limit' ? Number(price) : referencePrice;
    if (reference > 0 && reference * Number(amount) < Number(instrument.minNotional)) {
      issues.push(`${t('Below minimum notional')}: ${instrument.minNotional} ${quote}`);
    }
  }
  return issues;
}

export function VenueIcon({ id, short }: { id: string; short: string }) {
  const normalizedId = id.toLowerCase();
  const logo = exchangeLogoFor(normalizedId);
  return <i className={`venue-icon venue-${normalizedId}`} aria-hidden="true">
    {logo ? <img src={logo} alt="" /> : short}
  </i>;
}

export function VenueCell({ id, name, short }: { id: string; name: string; short: string }) {
  return <span className="venue-cell"><VenueIcon id={id} short={short} /><strong>{name}</strong></span>;
}

export function groupLevels(levels: Array<[string, string]>, step: number, direction: 'bid' | 'ask', limit: number): Array<{ price: number; size: number }> {
  if (step <= 0) {
    return levels.slice(0, limit).map(([price, size]) => ({ price: Number(price), size: Number(size) }));
  }
  const buckets = new Map<number, number>();
  for (const [price, size] of levels) {
    const quotient = Number(price) / step;
    const nearest = Math.round(quotient);
    // Feed prices sit on exact tick multiples, so a near-integer quotient is float noise — snap it
    // rather than let sub-1 steps (0.1, 0.5) push exact multiples into the neighbouring bucket.
    const units = Math.abs(quotient - nearest) < 1e-6 ? nearest : direction === 'bid' ? Math.floor(quotient) : Math.ceil(quotient);
    const bucket = Number((units * step).toFixed(8));
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + Number(size));
  }
  const ordered = [...buckets.entries()].sort((a, b) => direction === 'bid' ? b[0] - a[0] : a[0] - b[0]);
  return ordered.slice(0, limit).map(([price, size]) => ({ price, size }));
}

export type BookMode = 'Both' | 'Split' | 'Bids' | 'Asks';

export const BOOK_MODES: Array<{ id: BookMode; label: string }> = [
  { id: 'Both', label: 'Combined book' },
  { id: 'Split', label: 'Side-by-side book' },
  { id: 'Bids', label: 'Bids only' },
  { id: 'Asks', label: 'Asks only' },
];

export function BookModeGlyph({ mode }: { mode: BookMode }) {
  return <svg viewBox="0 0 14 14" aria-hidden="true">
    {mode === 'Both'
      ? <><rect className="g-ask" x="1" y="1" width="5.2" height="5.6" rx="1.3" /><rect className="g-bid" x="1" y="7.4" width="5.2" height="5.6" rx="1.3" /></>
      : <rect className={mode === 'Asks' ? 'g-ask' : 'g-bid'} x="1" y="1" width="5.2" height="12" rx="1.3" />}
    <rect className={mode === 'Split' ? 'g-ask' : 'g-neutral'} x="7.8" y="1" width="5.2" height="12" rx="1.3" />
  </svg>;
}

export const GROUP_STEP_MULTIPLIERS = [1, 5, 10, 100, 1000];

export function powerOfTenText(exponent: number): string {
  return exponent >= 0 ? (10 ** exponent).toString() : `0.${'0'.repeat(-exponent - 1)}1`;
}
