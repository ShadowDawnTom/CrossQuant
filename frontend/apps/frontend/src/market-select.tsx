import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import type { FundingOverviewResponse, FundingOverviewVenueEntry, LiveMarket, MarketCatalogAsset, MarketSnapshot } from './api.js';
import { marketQuoteForVenue, marketSymbol } from './market-symbol.js';

const UNFILTERED_LIMIT = 60;
const FILTERED_LIMIT = 150;

interface MarketSelectProps {
  asset: string;
  /** Trigger label, e.g. "BTCUSDT". */
  label: string;
  /** Active execution venue. Dropdown symbols and prices follow this venue when it lists the asset. */
  venue: string;
  subtitle: string;
  icon: string;
  catalog: MarketCatalogAsset[] | null;
  marketSnapshot: MarketSnapshot | null;
  favorites: string[];
  assetName: (asset: string) => string;
  assetIcon: (asset: string) => string;
  onSelect: (asset: string) => void;
  t: (key: string) => string;
}

function orderedVenues(entry: MarketCatalogAsset, preferredVenue: string) {
  const preferred = entry.venues.find((venue) => venue.venue === preferredVenue);
  return preferred ? [preferred, ...entry.venues.filter((venue) => venue !== preferred)] : entry.venues;
}

function referenceMarket(markets: Map<string, LiveMarket>, entry: MarketCatalogAsset, preferredVenue: string): LiveMarket | null {
  const preferredSymbol = entry.venues.find((venue) => venue.venue === preferredVenue)?.symbol;
  const preferred = preferredSymbol ? markets.get(preferredSymbol) : null;
  if (preferred?.source === 'gate_crossex_websocket') return preferred;
  let fallback: LiveMarket | null = null;
  for (const venue of orderedVenues(entry, preferredVenue)) {
    const market = markets.get(venue.symbol);
    if (!market || market.source !== 'gate_crossex_websocket') continue;
    // GATE reports open24h equal to the last price, flattening the 24h change to 0.00% — prefer
    // a venue whose open is real so the change column carries information.
    const open = Number(market.open24h);
    if (open > 0 && open !== Number(market.lastPrice)) return market;
    fallback ??= market;
  }
  return fallback;
}

function referenceBulkMarket(markets: Map<string, FundingOverviewVenueEntry>, entry: MarketCatalogAsset, preferredVenue: string): FundingOverviewVenueEntry | null {
  const preferredSymbol = entry.venues.find((venue) => venue.venue === preferredVenue)?.symbol;
  const preferred = preferredSymbol ? markets.get(preferredSymbol) : null;
  if (preferred && Number(preferred.lastPrice) > 0) return preferred;
  let fallback: FundingOverviewVenueEntry | null = null;
  for (const venue of orderedVenues(entry, preferredVenue)) {
    const market = markets.get(venue.symbol);
    if (!market || Number(market.lastPrice) <= 0) continue;
    if (market.change24h !== null) return market;
    fallback ??= market;
  }
  return fallback;
}

function formatRowPrice(price: number): string {
  if (price <= 0) return '—';
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (price >= 1) return price.toLocaleString('en-US', { maximumFractionDigits: 4 });
  // Sub-unit prices (PEPE, SHIB) vanish to "0" with fixed fraction digits.
  return price.toLocaleString('en-US', { maximumSignificantDigits: 4 });
}

export function MarketSelect({ asset, label, venue, subtitle, icon, catalog, marketSnapshot, favorites, assetName, assetIcon, onSelect, t }: MarketSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [bulkOverview, setBulkOverview] = useState<FundingOverviewResponse | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const listId = useId();

  useEffect(() => {
    // The live CrossEx socket is intentionally bounded and cannot cover the full catalog. Its
    // all-venue REST sweep supplies prices for catalog-only rows and is cached by the backend.
    let cancelled = false;
    void api.fundingOverview().then((response) => {
      if (!cancelled) setBulkOverview(response);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setQuery('');
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [open]);

  const favoriteAssets = useMemo(() => {
    const assets = new Set<string>();
    for (const symbol of favorites) {
      const parts = symbol.split('_');
      if (parts[2]) assets.add(parts[2]);
    }
    return assets;
  }, [favorites]);

  const liveBySymbol = useMemo(() => {
    const map = new Map<string, LiveMarket>();
    for (const market of marketSnapshot?.markets ?? []) map.set(market.symbol, market);
    return map;
  }, [marketSnapshot]);

  const bulkBySymbol = useMemo(() => {
    const map = new Map<string, FundingOverviewVenueEntry>();
    for (const entry of bulkOverview?.assets ?? []) {
      for (const venue of entry.venues) map.set(venue.symbol, venue);
    }
    return map;
  }, [bulkOverview]);

  const { rows, total } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (catalog ?? []).filter((entry) =>
      needle === '' || entry.asset.toLowerCase().includes(needle) || assetName(entry.asset).toLowerCase().includes(needle));
    const rank = (entry: MarketCatalogAsset) => favoriteAssets.has(entry.asset) ? 0 : entry.streamed ? 1 : 2;
    const ordered = [...matches].sort((left, right) => rank(left) - rank(right) || left.asset.localeCompare(right.asset));
    const limit = needle === '' ? UNFILTERED_LIMIT : FILTERED_LIMIT;
    return { rows: ordered.slice(0, limit), total: ordered.length };
  }, [catalog, query, favoriteAssets, assetName]);

  useEffect(() => {
    const selectedIndex = rows.findIndex((entry) => entry.asset === asset);
    setHighlight(selectedIndex >= 0 ? selectedIndex : 0);
  }, [asset, open, query, rows]);

  const choose = (nextAsset: string) => {
    onSelect(nextAsset);
    setOpen(false);
    setQuery('');
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const moveHighlight = (next: number) => {
    if (rows.length === 0) return;
    const bounded = Math.max(0, Math.min(next, rows.length - 1));
    setHighlight(bounded);
    listRef.current?.children[bounded]?.scrollIntoView({ block: 'nearest' });
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveHighlight(event.key === 'ArrowDown' ? highlight + 1 : highlight - 1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      moveHighlight(event.key === 'Home' ? 0 : rows.length - 1);
    } else if (event.key === 'Enter' && rows[highlight]) {
      event.preventDefault();
      choose(rows[highlight].asset);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      setQuery('');
      triggerRef.current?.focus();
    }
  };

  return <div className="pair-select" ref={rootRef}>
    <button ref={triggerRef} className={`pair-trigger${open ? ' open' : ''}`} onClick={() => setOpen((current) => !current)}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}>
      <span className="coin coin-large">{icon}</span>
      <span className="pair-trigger-text">
        <strong>{label} <i>⌄</i></strong>
        <small>{subtitle}</small>
      </span>
    </button>
    {open && <div className="pair-menu">
      <label className="pair-search">
        <span aria-hidden="true">⌕</span>
        <input autoFocus value={query} placeholder={t('Search asset')} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown} aria-label={t('Search asset')} role="combobox" aria-autocomplete="list"
          aria-controls={listId} aria-expanded={open}
          aria-activedescendant={rows[highlight] ? `${listId}-${rows[highlight].asset}` : undefined} />
        <em>{catalog === null ? '…' : `${total.toLocaleString('en-US')}`}</em>
      </label>
      <div className="pair-menu-head"><span>{t('Market name')}</span><span>{t('Price')}</span><span>24h</span></div>
      <ul id={listId} role="listbox" aria-label={t('Market name')} ref={listRef}>
        {rows.map((entry, index) => {
          const live = referenceMarket(liveBySymbol, entry, venue);
          const bulk = referenceBulkMarket(bulkBySymbol, entry, venue);
          const livePrice = Number(live?.lastPrice ?? 0);
          const price = livePrice > 0 ? livePrice : Number(bulk?.lastPrice ?? 0);
          const liveOpen = Number(live?.open24h ?? 0);
          const change = livePrice > 0 && liveOpen > 0
            ? ((livePrice / liveOpen) - 1) * 100
            : bulk?.change24h !== null && bulk?.change24h !== undefined ? Number(bulk.change24h) * 100 : null;
          // Selecting an asset keeps the active venue when possible; otherwise TradingView moves
          // to the first venue that actually lists it. Mirror that exact choice in this row.
          const quote = marketQuoteForVenue(entry.venues, venue);
          return <li id={`${listId}-${entry.asset}`} key={entry.asset} role="option" aria-selected={entry.asset === asset}
            className={`pair-row${index === highlight ? ' highlighted' : ''}${entry.asset === asset ? ' current' : ''}`}
            onMouseEnter={() => setHighlight(index)}
            onMouseDown={(event) => { event.preventDefault(); choose(entry.asset); }}>
              <span className="coin">{assetIcon(entry.asset)}</span>
              <span className="pair-row-name"><strong>{marketSymbol(entry.asset, quote, 'perpetual')}</strong><small>{assetName(entry.asset)} · {entry.venues.length}×</small></span>
              <span className="pair-row-price">{formatRowPrice(price)}</span>
              <span className={`pair-row-change${change !== null && change < 0 ? ' negative' : change !== null ? ' positive' : ''}`}>
                {change !== null ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '—'}
              </span>
          </li>;
        })}
        {rows.length === 0 && <li className="pair-empty">{catalog === null ? t('Loading instrument metadata…') : t('No matches')}</li>}
      </ul>
      {total > rows.length && <footer className="pair-menu-foot">{t('Showing')} {rows.length} / {total.toLocaleString('en-US')}</footer>}
    </div>}
  </div>;
}
