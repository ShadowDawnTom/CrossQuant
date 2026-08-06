import { Fragment, lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { contiguousCandleTail } from '@gate-crossex/shared-types';
import {
  api,
  ApiError,
  type AuthenticatedPortfolioSnapshot,
  type Candle,
  type CandleInterval,
  type CrossExInstrument,
  type ExecutionFill,
  type ExecutionOrder,
  type LiveBalance,
  type LiveMarket,
  type MarketCatalogAsset,
  type MarketSnapshot,
  type OrderBookSnapshot,
  type Position,
  type PublicMarketSnapshot,
  type PublicTrade,
  type TradingMode,
  type TradingSnapshot,
  type VenueFeeRate,
} from './api.js';
import { MarketSelect } from './market-select.js';
import { marketSymbol } from './market-symbol.js';
import { compactPrice, decimalPlaces, formatBookAmount, formatGroupStep, fullBookAmount } from './number-format.js';
import {
  BOOK_MODES,
  BookModeGlyph,
  GROUP_STEP_MULTIPLIERS,
  OPEN_ORDER_STATES,
  TIMEFRAMES,
  VenueCell,
  VenueIcon,
  assetIcon,
  assetName,
  balanceFor,
  balanceUnitFor,
  crossExSymbol,
  decimalScale,
  exchanges,
  floorToStep,
  formatAmount,
  formatCountdown,
  groupLevels,
  isPositiveDecimal,
  liveMarketFor,
  powerOfTenText,
  priceText,
  quoteFor,
  signedAmount,
  symbolParts,
  ticketIssues,
  useDialogFocus,
  usesSharedCrossExMargin,
  type BookMode,
  type OrderType,
  type Side,
} from './route-shared.js';
import { aggregatePositionFundingFee, positionFundingFee } from './position-funding-fees.js';
import { useLanguage } from './i18n.js';

const CandleChart = lazy(() => import('./charts.js').then((module) => ({ default: module.CandleChart })));

function OrderBookPanel({ book, trades, liveMarket, quote, base, sizeMultiplier, tickSize }: { book: OrderBookSnapshot | null; trades: PublicTrade[]; liveMarket: LiveMarket | null; quote: string; base: string; sizeMultiplier: number | null; tickSize: string | null }) {
  const { language, t } = useLanguage();
  const [bookMode, setBookMode] = useState<BookMode>('Both');
  const [tab, setTab] = useState<'book' | 'trades'>('book');
  const [groupIndex, setGroupIndex] = useState(0);
  const [groupOpen, setGroupOpen] = useState(false);
  const groupRef = useRef<HTMLDivElement | null>(null);
  const groupTriggerRef = useRef<HTMLButtonElement | null>(null);
  const groupItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (!groupOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (groupRef.current && !groupRef.current.contains(event.target as Node)) setGroupOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setGroupOpen(false);
        groupTriggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [groupOpen]);
  const openGroupMenu = () => {
    setGroupOpen(true);
    requestAnimationFrame(() => groupItemRefs.current[groupIndex]?.focus());
  };
  const onGroupMenuKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const current = groupItemRefs.current.findIndex((item) => item === document.activeElement);
    let next = current;
    if (event.key === 'ArrowDown') next = Math.min(groupSteps.length - 1, current + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, current - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = groupSteps.length - 1;
    else return;
    event.preventDefault();
    groupItemRefs.current[next]?.focus();
  };
  const midPrice = Number(liveMarket?.lastPrice ?? 0);
  // Grouping steps follow the venue tick size (×1/×5/×10/×100/×1000); until instrument metadata
  // arrives, a power-of-ten guess from the mid price stands in (never coarser than a real tick).
  const tickText = tickSize && isPositiveDecimal(tickSize) ? tickSize.trim() : powerOfTenText(midPrice > 0 ? Math.max(-6, Math.floor(Math.log10(midPrice)) - 6) : -1);
  const tickScale = decimalScale(tickText);
  const groupSteps = GROUP_STEP_MULTIPLIERS.map((multiplier) => Number((Number(tickText) * multiplier).toFixed(tickScale)));
  const step = groupSteps[groupIndex] ?? groupSteps[0];
  // Keep every book mode inside both terminal row heights (520px normally, 500px
  // below 920px). The tabs, controls, headings, and mid-price consume 138px,
  // leaving room for seven rows per side or fourteen rows in a single column.
  const levelLimit = bookMode === 'Both' ? 7 : 14;
  // The public feed relays venue-native sizes (contract counts on Gate/OKX, base units elsewhere).
  // When the backend knows the venue's contract size, sizes and sums are converted to base coin
  // and the column headers say so; without it the raw feed numbers are shown unlabeled.
  const factor = sizeMultiplier;
  const scale = (level: { price: number; size: number }) => factor === null ? level : { ...level, size: level.size * factor };
  const asks = groupLevels(book?.asks ?? [], step, 'ask', levelLimit).map(scale);
  const bids = groupLevels(book?.bids ?? [], step, 'bid', levelLimit).map(scale);
  const askRows = [...asks].reverse();
  let askSum = 0;
  const askSums = asks.map((level) => (askSum += level.size));
  const askSumByPrice = new Map(asks.map((level, index) => [level.price, askSums[index]]));
  let bidSum = 0;
  const bidRows = bids.map((level) => ({ ...level, sum: (bidSum += level.size) }));
  const maxSum = Math.max(askSums[askSums.length - 1] ?? 0, bidRows[bidRows.length - 1]?.sum ?? 0, 1);
  const digits = decimalPlaces(step);
  const tradeDigits = decimalPlaces(Number(tickText));
  const sumDigits = factor === null ? 0 : 4;
  const sizeHeader = factor === null ? t('Size') : t('Size (BTC)').replace('BTC', base);
  const sumHeader = factor === null ? t('Sum') : t('Sum (USDT)').replace('USDT', base);

  return <aside className="orderbook-panel terminal-panel">
    <div className="panel-tabs">
      <button className={tab === 'book' ? 'active' : ''} onClick={() => setTab('book')}>{t('Top of book')}</button>
      <button className={tab === 'trades' ? 'active' : ''} onClick={() => setTab('trades')}>{t('Trades')}</button>
    </div>
    {tab === 'book' && <>
      <div className="book-controls">
        <div className="book-modes" role="group" aria-label={t('Order book layout')}>
          {BOOK_MODES.map((mode) => <button key={mode.id} className={`depth-button${bookMode === mode.id ? ' active' : ''}`} onClick={() => setBookMode(mode.id)} aria-label={t(mode.label)} aria-pressed={bookMode === mode.id} title={t(mode.label)}><BookModeGlyph mode={mode.id} /></button>)}
        </div>
        <div className="group-select" ref={groupRef}>
          <button ref={groupTriggerRef} className={`group-trigger${groupOpen ? ' open' : ''}`}
            onClick={() => { if (groupOpen) setGroupOpen(false); else openGroupMenu(); }}
            onKeyDown={(event) => {
              if (!groupOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                openGroupMenu();
              }
            }}
            aria-haspopup="menu" aria-expanded={groupOpen} title={t('Grouping')}>
            {formatGroupStep(step)}
            <svg viewBox="0 0 8 5" aria-hidden="true"><path d="M1 1l3 3 3-3" /></svg>
          </button>
          {groupOpen && <ul className="group-menu" role="menu" aria-label={t('Grouping')} onKeyDown={onGroupMenuKeyDown}>
            {groupSteps.map((item, index) => <li key={item}>
              <button ref={(node) => { groupItemRefs.current[index] = node; }} role="menuitemradio"
                aria-checked={index === groupIndex} className={index === groupIndex ? 'selected' : ''}
                onClick={() => { setGroupIndex(index); setGroupOpen(false); groupTriggerRef.current?.focus(); }}>
                {formatGroupStep(item)}
              </button>
            </li>)}
          </ul>}
        </div>
      </div>
      {bookMode !== 'Split' && <div className="book-head"><span>{t('Price (USDT)').replace('USDT', quote)}</span><span>{sizeHeader}</span><span>{sumHeader}</span></div>}
      {book === null && <div className="book-empty">{t('No order book data yet')}</div>}
      {book !== null && (bookMode === 'Both' || bookMode === 'Asks') && <div className="book-rows asks">
        {askRows.map((level) => <div key={level.price} style={{ '--depth': `${Math.min(100, ((askSumByPrice.get(level.price) ?? 0) / maxSum) * 100)}%` } as React.CSSProperties}>
          <span>{level.price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}</span>
          <span title={fullBookAmount(level.size, 4)}>{formatBookAmount(level.size)}</span>
          <span title={fullBookAmount(askSumByPrice.get(level.price) ?? 0, sumDigits)}>{formatBookAmount(askSumByPrice.get(level.price) ?? 0)}</span>
        </div>)}
      </div>}
      {book !== null && <div className="mid-price"><strong>↑ {compactPrice(midPrice)}</strong><span>≈ ${compactPrice(midPrice)}</span></div>}
      {book !== null && (bookMode === 'Both' || bookMode === 'Bids') && <div className="book-rows bids">
        {bidRows.map((level) => <div key={level.price} style={{ '--depth': `${Math.min(100, (level.sum / maxSum) * 100)}%` } as React.CSSProperties}>
          <span>{level.price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}</span>
          <span title={fullBookAmount(level.size, 4)}>{formatBookAmount(level.size)}</span>
          <span title={fullBookAmount(level.sum, sumDigits)}>{formatBookAmount(level.sum)}</span>
        </div>)}
      </div>}
      {book !== null && bookMode === 'Split' && <div className="book-split">
        <div className="split-col bids-col">
          <div className="split-head"><span>{sizeHeader}</span><span>{t('Price')}</span></div>
          {bidRows.map((level) => <div key={level.price} style={{ '--depth': `${Math.min(100, (level.sum / maxSum) * 100)}%` } as React.CSSProperties}>
            <span title={fullBookAmount(level.size, 4)}>{formatBookAmount(level.size)}</span>
            <span className="split-price">{level.price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}</span>
          </div>)}
        </div>
        <div className="split-col asks-col">
          <div className="split-head"><span>{t('Price')}</span><span>{sizeHeader}</span></div>
          {asks.map((level) => <div key={level.price} style={{ '--depth': `${Math.min(100, ((askSumByPrice.get(level.price) ?? 0) / maxSum) * 100)}%` } as React.CSSProperties}>
            <span className="split-price">{level.price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}</span>
            <span title={fullBookAmount(level.size, 4)}>{formatBookAmount(level.size)}</span>
          </div>)}
        </div>
      </div>}
    </>}
    {tab === 'trades' && <>
      <div className="book-head"><span>{t('Price (USDT)').replace('USDT', quote)}</span><span>{sizeHeader}</span><span>{t('Time')}</span></div>
      {trades.length === 0 && <div className="book-empty">{t('No public trades yet')}</div>}
      <div className="book-rows trades-list">
        {trades.slice(0, 26).map((trade) => <div key={trade.id} className={trade.side === 'BUY' ? 'trade-buy' : 'trade-sell'}>
          <span>{Number(trade.price).toLocaleString('en-US', { minimumFractionDigits: tradeDigits, maximumFractionDigits: tradeDigits })}</span>
          <span title={fullBookAmount(Number(trade.quantity) * (factor ?? 1), 4)}>{formatBookAmount(Number(trade.quantity) * (factor ?? 1))}</span>
          <span>{new Date(trade.executedAt).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false })}</span>
        </div>)}
      </div>
    </>}
  </aside>;
}

interface TradingViewProps {
  asset: string;
  catalog: MarketCatalogAsset[] | null;
  onSelectAsset: (asset: string) => void;
  marketSnapshot: MarketSnapshot | null;
  tradingSnapshot: TradingSnapshot | null;
  authenticatedPortfolio: AuthenticatedPortfolioSnapshot | null;
  balances: Record<string, LiveBalance>;
  fees: VenueFeeRate[];
  orderBook: OrderBookSnapshot | null;
  publicTrades: { symbol: string; trades: PublicTrade[] };
  candleSeries: Record<string, Candle[]>;
  candleBackfilling: Record<string, boolean>;
  watchMarket: (symbol: string, interval: CandleInterval) => void;
  seedCandles: (key: string, candles: Candle[], building: boolean, replace?: boolean) => void;
  onTradingChanged: () => Promise<void>;
  onPositionsRefresh: () => Promise<void>;
  tradingMode: TradingMode | null;
  onOpenModeDialog: () => void;
  favorites: string[];
  onToggleFavorite: (symbol: string) => void;
  confirmOrders: boolean;
  onSetConfirmOrders: (value: boolean) => void;
}

export function TradingView({ asset, catalog, onSelectAsset, marketSnapshot, tradingSnapshot, authenticatedPortfolio, balances, fees, orderBook, publicTrades, candleSeries, candleBackfilling, watchMarket, seedCandles, onTradingChanged, onPositionsRefresh, tradingMode, onOpenModeDialog, favorites, onToggleFavorite, confirmOrders, onSetConfirmOrders }: TradingViewProps) {
  const { language, theme, t } = useLanguage();
  const [timeframe, setTimeframe] = useState('1m');
  const [side, setSide] = useState<Side>('Buy');
  const [orderType, setOrderType] = useState<OrderType>('Limit');
  const [price, setPrice] = useState('');
  const [priceDirty, setPriceDirty] = useState(false);
  const [amount, setAmount] = useState('');
  const [allocation, setAllocation] = useState(0);
  const [bottomTab, setBottomTab] = useState('Positions (0)');
  const [expandedPosition, setExpandedPosition] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; title: string; text: string } | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [skipFutureConfirmations, setSkipFutureConfirmations] = useState(false);
  const [exchangeId, setExchangeId] = useState('gate');
  const [pendingExchangeId, setPendingExchangeId] = useState<string | null>(null);
  const [venueMenuOpen, setVenueMenuOpen] = useState(false);
  const [venueHighlight, setVenueHighlight] = useState(0);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [chartTab, setChartTab] = useState<'chart' | 'overview'>('chart');
  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);
  const [readyCandleKey, setReadyCandleKey] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [instrumentCatalog, setInstrumentCatalog] = useState<CrossExInstrument[] | null>(null);
  const [officialFundingSnapshot, setOfficialFundingSnapshot] = useState<PublicMarketSnapshot | null>(null);
  const [sizeUnits, setSizeUnits] = useState<Record<string, string> | null>(null);
  const [maxLeverage, setMaxLeverage] = useState<string | null>(null);
  const [currentLeverage, setCurrentLeverage] = useState<string | null>(null);
  const [leverageOpen, setLeverageOpen] = useState(false);
  const [leverageDraft, setLeverageDraft] = useState('1');
  const [leverageUpdating, setLeverageUpdating] = useState(false);
  const [leverageError, setLeverageError] = useState<string | null>(null);
  const leverageRef = useRef<HTMLDivElement | null>(null);
  const venueRootRef = useRef<HTMLDivElement | null>(null);
  const venueTriggerRef = useRef<HTMLButtonElement | null>(null);
  const venueItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const venueMenuId = useId();
  const exchangeLoadRef = useRef(0);
  const historyLoadingRef = useRef<Set<string>>(new Set());
  const historyExhaustedRef = useRef<Set<string>>(new Set());
  const historyRequestedBeforeRef = useRef<Map<string, number>>(new Map());
  const initializedCandleKeysRef = useRef<Set<string>>(new Set());
  const confirmDialogRef = useDialogFocus(confirming, () => setConfirming(false));
  const catalogAsset = useMemo(() => catalog?.find((item) => item.asset === asset) ?? null, [catalog, asset]);
  const venueEntry = catalogAsset?.venues.find((item) => item.venue === exchangeId.toUpperCase()) ?? null;
  const exchange = exchanges.find((item) => item.id === exchangeId) ?? exchanges[0];
  const symbol = venueEntry?.symbol ?? crossExSymbol(exchangeId, asset);
  const quote = venueEntry?.quote ?? quoteFor(exchangeId);
  const interval = TIMEFRAMES.find((item) => item.label === timeframe)?.interval ?? '1m';
  const candleKey = `${symbol}:${interval}`;
  const chartReady = readyCandleKey === candleKey;
  const candles = useMemo(
    () => chartReady ? contiguousCandleTail(candleSeries[candleKey] ?? [], interval) : [],
    [chartReady, candleSeries, candleKey, interval],
  );
  const liveMarket = liveMarketFor(marketSnapshot, exchangeId, asset);
  const nextFundingAt = exchangeId === 'okx' && officialFundingSnapshot?.symbol === symbol
    ? officialFundingSnapshot.nextFundingAt
    : liveMarket?.nextFundingAt;
  // A market just registered from the catalog has no ticker yet; the freshest candle close
  // stands in until the first push instead of showing a fabricated seed price.
  const livePrice = Number(liveMarket?.lastPrice ?? 0);
  const displayedPrice = livePrice > 0 ? livePrice : Number(candles[candles.length - 1]?.close ?? 0);
  const instrument = useMemo(() => instrumentCatalog?.find((item) => item.symbol === symbol) ?? null, [instrumentCatalog, symbol]);
  const sizeUnitText = sizeUnits?.[symbol];
  const sizeMultiplier = sizeUnitText !== undefined && isPositiveDecimal(sizeUnitText) ? Number(sizeUnitText) : null;
  const effectivePrice = orderType === 'Market' ? displayedPrice : Number(price) || 0;
  const total = (effectivePrice * (Number(amount) || 0)).toFixed(2);
  const issues = useMemo(() => ticketIssues({ orderType, price, amount, referencePrice: displayedPrice, quote, instrument, t }),
    [orderType, price, amount, displayedPrice, quote, instrument, t]);
  const availableBalance = balanceFor(balances, authenticatedPortfolio, exchangeId);
  const sharedMarginMode = usesSharedCrossExMargin(authenticatedPortfolio);
  const availableBalanceUnit = balanceUnitFor(authenticatedPortfolio, exchangeId);
  const displayedBalance = availableBalance ? Number(availableBalance).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
  const venueFee = fees.find((fee) => fee.venue === exchangeId.toUpperCase());
  const takerFeeText = venueFee ? `${(Number(venueFee.futureTakerFee) * 100).toFixed(4)}%` : t('Exchange setting');
  const makerFeeText = venueFee ? `${(Number(venueFee.futureMakerFee) * 100).toFixed(4)}%` : t('Exchange setting');
  const referenceCandle = chartReady ? hoveredCandle ?? candles[candles.length - 1] ?? null : null;
  const isFavorite = favorites.includes(symbol);
  const portfolioPosition = authenticatedPortfolio?.snapshot.futuresPositions?.find((position) => position.symbol === symbol);
  const leverageText = currentLeverage ?? portfolioPosition?.leverage ?? instrument?.defaultLeverage ?? '1';
  const leverageCeiling = Math.max(1, Math.floor(Number(maxLeverage ?? portfolioPosition?.maxLeverage ?? leverageText) || 1));
  const leverageValue = Math.min(leverageCeiling, Math.max(1, Number(leverageText) || 1));
  const maxQuantityReference = orderType === 'Limit' && isPositiveDecimal(price) ? Number(price) : displayedPrice;
  const instrumentSizeCap = orderType === 'Market' ? instrument?.maxMarketSize : instrument?.maxLimitSize;
  const maxOrderQuantity = (() => {
    if (reduceOnly) {
      const positionSize = Math.abs(Number(tradingSnapshot?.positions.find((position) => position.symbol === symbol)?.quantity ?? 0));
      return floorToStep(positionSize, instrument?.lotSize ?? null);
    }
    const available = Number(availableBalance);
    if (availableBalance === null || !Number.isFinite(available) || available < 0 || maxQuantityReference <= 0) return '';
    const marginMaximum = (available * leverageValue) / maxQuantityReference;
    const venueMaximum = instrumentSizeCap && isPositiveDecimal(instrumentSizeCap) ? Number(instrumentSizeCap) : Number.POSITIVE_INFINITY;
    const maximum = Math.min(marginMaximum, venueMaximum);
    return Number.isFinite(maximum) ? floorToStep(maximum, instrument?.lotSize ?? null) : '';
  })();
  const leveragePresets = [...new Set([1, 3, 5, 10, 20, leverageCeiling])].filter((value) => value <= leverageCeiling).sort((a, b) => a - b);

  function selectExchange(nextExchangeId: string) {
    if (nextExchangeId === exchangeId && pendingExchangeId === null) return;
    const targetEntry = catalogAsset?.venues.find((item) => item.venue === nextExchangeId.toUpperCase()) ?? null;
    const targetSymbol = targetEntry?.symbol ?? crossExSymbol(nextExchangeId, asset);
    const targetKey = `${targetSymbol}:${interval}`;
    const requestId = ++exchangeLoadRef.current;
    setPendingExchangeId(nextExchangeId);

    const commit = () => {
      if (exchangeLoadRef.current !== requestId) return;
      setExchangeId(nextExchangeId);
      setPendingExchangeId(null);
    };
    if ((candleSeries[targetKey]?.length ?? 0) > 1) {
      commit();
      return;
    }
    void api.candles(targetSymbol, interval).then((response) => {
      if (exchangeLoadRef.current !== requestId) return;
      initializedCandleKeysRef.current.add(targetKey);
      if (response.hasMore) historyExhaustedRef.current.delete(targetKey);
      else historyExhaustedRef.current.add(targetKey);
      seedCandles(targetKey, response.candles, response.building && response.source === 'crossex_websocket_only', true);
      commit();
    }).catch(commit);
  }

  const venueIsAvailable = (venueId: string) =>
    catalogAsset === null || catalogAsset.venues.some((entry) => entry.venue === venueId.toUpperCase());

  const enabledVenueIndexes = () => exchanges
    .map((item, index) => venueIsAvailable(item.id) ? index : -1)
    .filter((index) => index >= 0);

  const focusVenue = (index: number) => {
    setVenueHighlight(index);
    requestAnimationFrame(() => venueItemRefs.current[index]?.focus());
  };

  const openVenueMenuFromKeyboard = (direction: 1 | -1) => {
    const enabled = enabledVenueIndexes();
    if (enabled.length === 0) return;
    const selectedIndex = exchanges.findIndex((item) => item.id === exchangeId);
    const selectedPosition = enabled.indexOf(selectedIndex);
    const targetPosition = selectedPosition >= 0
      ? (selectedPosition + (direction > 0 ? 0 : enabled.length - 1)) % enabled.length
      : direction > 0 ? 0 : enabled.length - 1;
    setVenueMenuOpen(true);
    focusVenue(enabled[targetPosition]);
  };

  const chooseVenue = (nextExchangeId: string) => {
    setVenueMenuOpen(false);
    if (nextExchangeId !== exchangeId) selectExchange(nextExchangeId);
    requestAnimationFrame(() => venueTriggerRef.current?.focus());
  };

  const onVenueTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    openVenueMenuFromKeyboard(event.key === 'ArrowDown' ? 1 : -1);
  };

  const onVenueMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const enabled = enabledVenueIndexes();
    if (enabled.length === 0) return;
    const currentPosition = Math.max(0, enabled.indexOf(venueHighlight));
    let targetPosition: number | null = null;
    if (event.key === 'ArrowDown') targetPosition = (currentPosition + 1) % enabled.length;
    else if (event.key === 'ArrowUp') targetPosition = (currentPosition - 1 + enabled.length) % enabled.length;
    else if (event.key === 'Home') targetPosition = 0;
    else if (event.key === 'End') targetPosition = enabled.length - 1;
    if (targetPosition === null) return;
    event.preventDefault();
    focusVenue(enabled[targetPosition]);
  };

  useEffect(() => {
    if (!venueMenuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (venueRootRef.current && !venueRootRef.current.contains(event.target as Node)) setVenueMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setVenueMenuOpen(false);
      venueTriggerRef.current?.focus();
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [venueMenuOpen]);

  useEffect(() => {
    // A pending venue page belongs to the asset and timeframe it was requested for. Invalidate it
    // if either changes so a late response cannot switch the terminal back to stale context.
    exchangeLoadRef.current += 1;
    setPendingExchangeId(null);
  }, [asset, interval]);

  useEffect(() => {
    // Switching market or venue starts a fresh ticket; the price becomes auto-fill again.
    setPrice('');
    setPriceDirty(false);
    setAllocation(0);
    setConfirming(false);
  }, [symbol]);

  useEffect(() => {
    // The catalog is the source of truth for listings: when the chosen asset does not trade on
    // the current venue, jump to the first venue that lists it.
    if (!catalogAsset || catalogAsset.venues.length === 0) return;
    if (!catalogAsset.venues.some((item) => item.venue === exchangeId.toUpperCase())) {
      const fallback = catalogAsset.venues[0].venue.toLowerCase();
      if (exchanges.some((item) => item.id === fallback)) {
        exchangeLoadRef.current += 1;
        setPendingExchangeId(null);
        setExchangeId(fallback);
      }
    }
  }, [catalogAsset, exchangeId]);

  useEffect(() => {
    // Follow the live price only while the user has not typed a price of their own — an
    // auto-fill must never overwrite a limit price mid-entry. While the confirmation dialog is
    // open the price freezes: what the user confirms must be exactly what is submitted.
    if (confirming) return;
    if (!priceDirty && liveMarket?.source === 'gate_crossex_websocket' && liveMarket.lastPrice !== price) {
      setPrice(liveMarket.lastPrice);
    }
  }, [confirming, priceDirty, liveMarket?.source, liveMarket?.lastPrice, price]);

  useEffect(() => {
    // Any change to what would be submitted closes an open confirmation dialog.
    setConfirming(false);
  }, [side, orderType, price, amount, reduceOnly, exchangeId]);

  useEffect(() => {
    if (!leverageOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (leverageRef.current && !leverageRef.current.contains(event.target as Node)) setLeverageOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setLeverageOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [leverageOpen]);

  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.instruments().then((response) => { if (!cancelled) setInstrumentCatalog(response.items); }).catch(() => undefined);
    void api.sizeUnits().then((response) => { if (!cancelled) setSizeUnits(response.units); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setOfficialFundingSnapshot(null);
    if (exchangeId !== 'okx') return;
    let cancelled = false;
    const refresh = () => {
      void api.publicMarketSnapshot(symbol)
        .then((response) => { if (!cancelled) setOfficialFundingSnapshot(response.snapshot); })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [exchangeId, symbol]);

  const sizeUnitRetryRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // A market registered after boot is missing from the first size-units map; fetch once more
    // per symbol so its book sizes get base-unit labels (the backend re-derives on registration).
    if (sizeUnits === null || sizeUnits[symbol] !== undefined || sizeUnitRetryRef.current.has(symbol)) return;
    sizeUnitRetryRef.current.add(symbol);
    let cancelled = false;
    void api.sizeUnits().then((response) => { if (!cancelled) setSizeUnits(response.units); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [symbol, sizeUnits]);

  const showNotice = useCallback((kind: 'ok' | 'error', title: string, text: string) => {
    setNotice({ kind, title, text });
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), kind === 'error' ? 6500 : 3500);
  }, []);

  useEffect(() => {
    watchMarket(symbol, interval);
  }, [symbol, interval, watchMarket]);

  useLayoutEffect(() => {
    // A previously visited key can still contain persisted candles. Hide it before the browser
    // paints the new selection; the fresh request below reveals the series only once it is
    // current, preventing a cached chart followed by a second "actual" chart.
    setReadyCandleKey(null);
    setHoveredCandle(null);
  }, [candleKey]);

  useEffect(() => {
    let cancelled = false;
    void api.candles(symbol, interval, { fresh: true }).then((response) => {
      if (cancelled) return;
      initializedCandleKeysRef.current.add(candleKey);
      if (response.hasMore) historyExhaustedRef.current.delete(candleKey);
      else historyExhaustedRef.current.add(candleKey);
      seedCandles(candleKey, response.candles, response.building && response.source === 'crossex_websocket_only', true);
      setReadyCandleKey(candleKey);
    }).catch(() => {
      // If the refresh fails, reveal any cached/live series instead of leaving the chart blank.
      if (!cancelled) setReadyCandleKey(candleKey);
    });
    return () => { cancelled = true; };
  }, [symbol, interval, candleKey, seedCandles]);

  const loadOlderCandles = useCallback(() => {
    const oldest = candles[0];
    if (!oldest || historyLoadingRef.current.has(candleKey) || historyExhaustedRef.current.has(candleKey)
      || historyRequestedBeforeRef.current.get(candleKey) === oldest.startTime) return;
    historyLoadingRef.current.add(candleKey);
    historyRequestedBeforeRef.current.set(candleKey, oldest.startTime);
    void api.candles(symbol, interval, { before: oldest.startTime, limit: 300 }).then((response) => {
      if (response.candles.length === 0 || !response.hasMore) historyExhaustedRef.current.add(candleKey);
      seedCandles(candleKey, response.candles, false);
    }).catch(() => {
      // A transient venue failure should be retryable after the next range change.
      historyRequestedBeforeRef.current.delete(candleKey);
    }).finally(() => {
      historyLoadingRef.current.delete(candleKey);
    });
  }, [candles, candleKey, symbol, interval, seedCandles]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setMaxLeverage(null);
    setCurrentLeverage(null);
    setLeverageOpen(false);
    setLeverageError(null);
    void api.riskLimits(symbol).then((response) => {
      if (cancelled) return;
      const leverages = response.item.tiers.map((tier) => Number(tier.leverageMax)).filter(Number.isFinite);
      if (leverages.length) setMaxLeverage(String(Math.max(...leverages)));
    }).catch(() => undefined);
    void api.leverage(symbol).then((response) => {
      if (!cancelled && response.leverage && isPositiveDecimal(response.leverage)) {
        setCurrentLeverage(response.leverage);
        setLeverageDraft(response.leverage);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [symbol]);

  function applyAllocation(value: number) {
    setAllocation(value);
    const maximum = Number(maxOrderQuantity);
    if (maximum > 0 && value > 0) {
      const raw = (maximum * value) / 100;
      setAmount(floorToStep(raw, instrument?.lotSize ?? null) || raw.toFixed(6));
    } else if (value === 0) {
      setAmount('');
    }
  }

  function openLeverageEditor() {
    if (tradingMode !== 'live') {
      onOpenModeDialog();
      return;
    }
    setLeverageDraft(String(leverageValue));
    setLeverageError(null);
    setLeverageOpen(true);
  }

  function adjustLeverage(delta: number) {
    const next = Math.min(leverageCeiling, Math.max(1, Math.round(Number(leverageDraft) || leverageValue) + delta));
    setLeverageDraft(String(next));
  }

  async function applyLeverage() {
    const next = Math.round(Number(leverageDraft));
    if (!Number.isFinite(next) || next < 1 || next > leverageCeiling) {
      setLeverageError(`${t('Max leverage')}: ${leverageCeiling}×`);
      return;
    }
    setLeverageUpdating(true);
    setLeverageError(null);
    try {
      const response = await api.setLeverage(symbol, String(next));
      setCurrentLeverage(response.leverage);
      setLeverageDraft(response.leverage);
      setLeverageOpen(false);
      setAllocation(0);
      showNotice('ok', t('Leverage updated'), `${exchange.name} · ${response.leverage}×`);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : t('Backend unavailable');
      setLeverageError(message);
      showNotice('error', t('Leverage rejected'), message);
    } finally {
      setLeverageUpdating(false);
    }
  }

  function requestSubmit() {
    if (submitting || issues.length > 0) return;
    if (!confirmOrders) {
      void submitOrder();
      return;
    }
    setSkipFutureConfirmations(false);
    setConfirming(true);
  }

  async function submitOrder() {
    if (submitting || issues.length > 0) return;
    setConfirming(false);
    setSubmitting(true);
    try {
      const order = await api.createOrder({
        symbol: liveMarket?.symbol ?? symbol,
        side: side === 'Buy' ? 'BUY' : 'SELL', type: orderType === 'Market' ? 'MARKET' : 'LIMIT',
        timeInForce: orderType === 'Market' ? 'IOC' : 'GTC', quantity: amount,
        ...(orderType === 'Limit' ? { price } : {}), reduceOnly,
      });
      showNotice('ok', t('Execution update'), `${order.state}: ${t(side)} ${amount || '0'} ${asset} ${t('on')} ${exchange.name}`);
      await onTradingChanged();
    } catch (error) {
      showNotice('error', t('Order rejected'), error instanceof ApiError ? error.message : t('Backend unavailable'));
    } finally {
      setSubmitting(false);
    }
  }

  return <>
    <section className="market-header">
      <div className="pair-title"><MarketSelect asset={asset} label={marketSymbol(asset, quote, 'perpetual')} venue={exchangeId.toUpperCase()} subtitle={`${assetName(asset)} ${t('Perpetual').toLowerCase()}`} icon={assetIcon(asset)} catalog={catalog} marketSnapshot={marketSnapshot} favorites={favorites} assetName={assetName} assetIcon={assetIcon} onSelect={onSelectAsset} t={t} /></div>
      <div className="exchange-control" ref={venueRootRef}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setVenueMenuOpen(false);
        }}>
        <button ref={venueTriggerRef} className={`exchange-selector${venueMenuOpen ? ' open' : ''}`}
          onClick={() => {
            setVenueHighlight(Math.max(0, exchanges.findIndex((item) => item.id === exchangeId)));
            setVenueMenuOpen((current) => !current);
          }} onKeyDown={onVenueTriggerKeyDown}
          aria-label={`${t('Execution venue')}: ${exchange.name}`} aria-haspopup="menu" aria-expanded={venueMenuOpen}
          aria-controls={venueMenuOpen ? venueMenuId : undefined}>
          <VenueIcon id={exchange.id} short={exchange.short} />
          <span className="exchange-details">
            <small>{t('Execution venue')}</small>
            <span className="exchange-summary">
              <strong>{exchange.name}</strong>
              <span className="venue-health"><i />{pendingExchangeId ? t('Loading chart…') : liveMarket?.source === 'gate_crossex_websocket' ? t('Connected') : 'SEED'}</span>
            </span>
          </span>
          <span className="exchange-chevron" aria-hidden="true">⌄</span>
        </button>
        {venueMenuOpen && <div id={venueMenuId} className="exchange-menu" role="menu" aria-label={t('Execution venue')}
          onKeyDown={onVenueMenuKeyDown}>
          <header><span>{t('Execution venue')}</span><small>{asset} {t('Perpetual').toLowerCase()}</small></header>
          <div className="exchange-menu-list">
            {exchanges.map((item, index) => {
              const available = venueIsAvailable(item.id);
              const selected = item.id === exchangeId;
              return <button key={item.id} ref={(node) => { venueItemRefs.current[index] = node; }}
                className={`${selected ? 'selected' : ''}${index === venueHighlight ? ' highlighted' : ''}`}
                role="menuitemradio" aria-checked={selected} disabled={!available} tabIndex={index === venueHighlight ? 0 : -1}
                onMouseEnter={() => { if (available) setVenueHighlight(index); }} onClick={() => chooseVenue(item.id)}>
                <VenueIcon id={item.id} short={item.short} />
                <span><strong>{item.name}</strong><small>{marketSymbol(asset, catalogAsset?.venues.find((venue) => venue.venue === item.id.toUpperCase())?.quote ?? quoteFor(item.id), 'perpetual')}</small></span>
                {selected && <i className="exchange-check" aria-hidden="true">✓</i>}
              </button>;
            })}
          </div>
        </div>}
      </div>
      <div className="headline-price"><strong>{priceText(displayedPrice)}</strong></div>
      <dl className="market-stats">
        <div><dt>{t('Best bid')}</dt><dd>{priceText(Number(liveMarket?.bidPrice ?? displayedPrice))}</dd></div><div><dt>{t('24h high')}</dt><dd>{priceText(Number(liveMarket?.high24h ?? displayedPrice))}</dd></div><div><dt>{t('24h low')}</dt><dd>{priceText(Number(liveMarket?.low24h ?? displayedPrice))}</dd></div><div><dt>{t('24h volume')}</dt><dd>{liveMarket?.quoteVolume24h ? `$${(Number(liveMarket.quoteVolume24h) / 1_000_000).toFixed(1)}M` : '—'}</dd></div><div><dt>{t('Funding / Interval')}</dt><dd><span className={Number(liveMarket?.fundingRate ?? 0) >= 0 ? 'positive' : 'negative'}>{((Number(liveMarket?.fundingRate ?? 0)) * 100).toFixed(4)}%</span> · {formatCountdown(nextFundingAt, clock)}</dd></div>
      </dl>
      <button className="star-button" onClick={() => onToggleFavorite(symbol)} aria-label={`${isFavorite ? 'Remove' : 'Add'} ${asset} favorite`} aria-pressed={isFavorite}>{isFavorite ? '★' : '☆'}</button>
    </section>

    <section className="terminal-grid">
      <div className="chart-panel terminal-panel">
        <div className="panel-tabs"><button className={chartTab === 'chart' ? 'active' : ''} onClick={() => setChartTab('chart')}>{t('Chart')}</button><button className={chartTab === 'overview' ? 'active' : ''} onClick={() => setChartTab('overview')}>{t('Overview')}</button><span className="spacer" /><button className="icon-button" aria-label={t('Expand chart')} onClick={() => document.querySelector('.chart-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>⛶</button></div>
        {chartTab === 'chart' && <>
          <div className="chart-toolbar">
            {TIMEFRAMES.map((item) => <button className={timeframe === item.label ? 'active' : ''} key={item.label} onClick={() => setTimeframe(item.label)}>{item.label}</button>)}
            <span className="toolbar-divider" /><span className="live-market"><i /> {t('Live candles')}</span>
            <a className="tv-attribution" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">{t('Charts by TradingView')}</a>
          </div>
          <div className="ohlc"><span>O&nbsp; {referenceCandle ? compactPrice(Number(referenceCandle.open)) : '—'}</span><span>H&nbsp; {referenceCandle ? compactPrice(Number(referenceCandle.high)) : '—'}</span><span>L&nbsp; {referenceCandle ? compactPrice(Number(referenceCandle.low)) : '—'}</span><span>C&nbsp; {referenceCandle ? compactPrice(Number(referenceCandle.close)) : '—'}</span></div>
          <Suspense fallback={<div className="price-chart chart-module-loading" role="status">{t('Loading chart…')}</div>}>
            <CandleChart key={candleKey} candles={candles} interval={interval} seriesKey={candleKey} theme={theme} locale={language === 'zh' ? 'zh-CN' : 'en-US'}
              placeholder={t(!chartReady ? 'Loading chart…' : candleBackfilling[candleKey] ? 'Backfilling venue history…' : 'Collecting live candles…')}
              onHover={setHoveredCandle} onLoadMore={loadOlderCandles} />
          </Suspense>
        </>}
        {chartTab === 'overview' && <div className="instrument-overview">
          {instrumentCatalog === null && <p className="overview-note">{t('Loading instrument metadata…')}</p>}
          {instrumentCatalog !== null && instrument === null && <p className="overview-note">{t('Instrument metadata unavailable for this venue.')}</p>}
          {instrument !== null && <dl>
            <div><dt>{t('Instrument')}</dt><dd>{marketSymbol(asset, quote, 'perpetual')}</dd></div>
            <div><dt>{t('Tick size')}</dt><dd>{instrument.tickSize}</dd></div>
            <div><dt>{t('Lot size')}</dt><dd>{instrument.lotSize}</dd></div>
            <div><dt>{t('Min size')}</dt><dd>{instrument.minSize}</dd></div>
            <div><dt>{t('Min notional')}</dt><dd>{instrument.minNotional ?? '—'}</dd></div>
            <div><dt>{t('Contract size')}</dt><dd>{instrument.contractSize ?? '—'}</dd></div>
            <div><dt>{t('Max leverage')}</dt><dd>{maxLeverage ? `${maxLeverage}×` : '—'}</dd></div>
            <div><dt>{t('Maker fee')}</dt><dd>{makerFeeText}</dd></div>
            <div><dt>{t('Taker fee')}</dt><dd>{takerFeeText}</dd></div>
            <div><dt>{t('Funding / Interval')}</dt><dd>{((Number(liveMarket?.fundingRate ?? 0)) * 100).toFixed(4)}%</dd></div>
            <div><dt>{t('Next funding')}</dt><dd>{formatCountdown(nextFundingAt, clock)}</dd></div>
            <div><dt>{t('Status')}</dt><dd>{instrument.state}</dd></div>
          </dl>}
        </div>}
      </div>

      <OrderBookPanel book={orderBook?.symbol === symbol ? orderBook : null} trades={publicTrades.symbol === symbol ? publicTrades.trades : []} liveMarket={liveMarket} quote={quote} base={asset} sizeMultiplier={sizeMultiplier} tickSize={instrument?.tickSize ?? null} />

      <aside className="order-panel terminal-panel">
        <div className="trade-side-tabs"><button className={side === 'Buy' ? 'active buy' : ''} onClick={() => setSide('Buy')}>{t('Buy / Long')}</button><button className={side === 'Sell' ? 'active sell' : ''} onClick={() => setSide('Sell')}>{t('Sell / Short')}</button></div>
        <div className="ticket-toolbar">
          <div className="order-type-tabs">{(['Limit', 'Market'] as OrderType[]).map((type) => <button className={orderType === type ? 'active' : ''} onClick={() => setOrderType(type)} key={type}>{t(type)}</button>)}</div>
          <div className="leverage-control" ref={leverageRef}>
            <button className={`leverage-trigger${leverageOpen ? ' open' : ''}`} onClick={openLeverageEditor} aria-haspopup="dialog" aria-expanded={leverageOpen} title={t('Set leverage')}>
              {leverageValue}× <span>⌄</span>
            </button>
            {leverageOpen && <div className="leverage-popover" role="dialog" aria-label={t('Adjust leverage')}>
              <header><div><strong>{t('Adjust leverage')}</strong><span>{exchange.name} · {marketSymbol(asset, quote, 'perpetual')}</span></div><button onClick={() => setLeverageOpen(false)} aria-label={t('Close')}>✕</button></header>
              <dl><div><dt>{t('Current leverage')}</dt><dd>{leverageValue}×</dd></div><div><dt>{t('Max leverage')}</dt><dd>{leverageCeiling}×</dd></div></dl>
              <div className="leverage-stepper">
                <button onClick={() => adjustLeverage(-1)} aria-label="Decrease leverage">−</button>
                <label><input type="number" min="1" max={leverageCeiling} step="1" value={leverageDraft} onChange={(event) => setLeverageDraft(event.target.value)} aria-label={t('Leverage')} /><b>×</b></label>
                <button onClick={() => adjustLeverage(1)} aria-label="Increase leverage">+</button>
              </div>
              <input className="leverage-range" type="range" min="1" max={leverageCeiling} step="1" value={Math.min(leverageCeiling, Math.max(1, Math.round(Number(leverageDraft) || 1)))} onChange={(event) => setLeverageDraft(event.target.value)} aria-label={t('Leverage')} />
              <div className="leverage-presets">{leveragePresets.map((value) => <button className={Number(leverageDraft) === value ? 'active' : ''} key={value} onClick={() => setLeverageDraft(String(value))}>{value}×</button>)}</div>
              {leverageError && <p role="alert">{leverageError}</p>}
              <button className="apply-leverage" onClick={() => void applyLeverage()} disabled={leverageUpdating}>{leverageUpdating ? t('Applying…') : t('Apply leverage')}</button>
            </div>}
          </div>
        </div>
        {orderType !== 'Market' && <label className="trade-input"><span>{t('Price')}</span><input value={price} onChange={(event) => { setPrice(event.target.value); setPriceDirty(true); }} inputMode="decimal" /><b>{quote}</b></label>}
        <label className="trade-input"><span>{t('Amount')}</span><input value={amount} onChange={(event) => { setAmount(event.target.value); setAllocation(0); }} inputMode="decimal" /><b>{asset}</b></label>
        <div className="allocation">
          <input type="range" min="0" max="100" step="25" value={allocation} onChange={(event) => applyAllocation(Number(event.target.value))} style={{ '--allocation': `${allocation}%` } as React.CSSProperties} />
          <div><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
        </div>
        <label className="trade-input total"><span>{t('Total')}</span><input value={total} readOnly /><b>{quote}</b></label>
        <div className="order-options"><label><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} /> {t('Reduce only')}</label></div>
        {issues.length > 0 && (amount !== '' || (orderType === 'Limit' && price !== '' && priceDirty)) &&
          <p className="ticket-issue" role="status">{issues[0]}</p>}
        {tradingMode !== 'live'
          ? <button className="submit-order locked" onClick={onOpenModeDialog}>
            <strong>{t('Live trading locked')}</strong>
            <span>{t('Switch trading mode')}</span>
          </button>
          : <button className={side === 'Buy' ? 'submit-order buy' : 'submit-order sell'} onClick={requestSubmit} disabled={submitting || issues.length > 0}>
            <strong>{submitting ? t('Submitting…') : `${t(side)} ${asset}`}</strong>
            <span>{t('on')} {exchange.name}</span>
          </button>}
        <dl className="order-summary">
          <div><dt>{t(sharedMarginMode ? 'Shared margin' : 'Available balance')}</dt><dd>{displayedBalance} {availableBalanceUnit}</dd></div>
          <div><dt>{t('Max order quantity')}</dt><dd><button className="max-quantity" onClick={() => { if (maxOrderQuantity) { setAmount(maxOrderQuantity); setAllocation(100); } }} disabled={!maxOrderQuantity}>{maxOrderQuantity || '—'} {asset}</button></dd></div>
          <div><dt>{t('Leverage')}</dt><dd><button className="summary-leverage" onClick={openLeverageEditor}>{leverageValue}×</button></dd></div>
          <div><dt>{t('Est. liquidation price')}</dt><dd>{t('Available after execution')}</dd></div>
          <div><dt>{t('Maker fee')}</dt><dd>{makerFeeText}</dd></div>
          <div><dt>{t('Taker fee')}</dt><dd>{takerFeeText}</dd></div>
        </dl>
      </aside>
    </section>

    <ExecutionTables snapshot={tradingSnapshot} portfolio={authenticatedPortfolio} bottomTab={bottomTab} setBottomTab={setBottomTab} expandedPosition={expandedPosition} setExpandedPosition={setExpandedPosition} onTradingChanged={onTradingChanged} onPositionsRefresh={onPositionsRefresh} notify={showNotice} tradingMode={tradingMode} onOpenModeDialog={onOpenModeDialog} />
    {confirming && <div className="modal-backdrop confirm-order-backdrop" role="presentation" onMouseDown={() => setConfirming(false)}>
      <section ref={confirmDialogRef} tabIndex={-1} className="confirm-order-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-order-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className={`eyebrow ${side === 'Buy' ? 'positive' : 'negative'}`}>{t(side === 'Buy' ? 'Buy / Long' : 'Sell / Short')}</p>
            <h2 id="confirm-order-title">{t('Confirm order')}</h2>
            <span className="confirm-market">{marketSymbol(asset, quote, 'perpetual')} {t('Perpetual').toLowerCase()} · {exchange.name}</span>
          </div>
          <button className="disclaimer-close" aria-label={t('Close')} onClick={() => setConfirming(false)}>×</button>
        </header>
        <dl className="confirm-order-summary">
          <div><dt>{t('Side')}</dt><dd className={side === 'Buy' ? 'positive' : 'negative'}>{t(side)} · {t(orderType)}</dd></div>
          <div><dt>{t('Price')}</dt><dd>{orderType === 'Limit' ? `${price} ${quote}` : t('Market')}</dd></div>
          <div><dt>{t('Amount')}</dt><dd>{amount} {asset}</dd></div>
          <div><dt>{t('Total')}</dt><dd>≈ {total} {quote}</dd></div>
          <div><dt>{t('Leverage')}</dt><dd>{leverageValue}×</dd></div>
          <div><dt>{t('Reduce only')}</dt><dd>{t(reduceOnly ? 'Yes' : 'No')}</dd></div>
        </dl>
        <label className="disclaimer-agree confirm-skip">
          <input type="checkbox" checked={skipFutureConfirmations} onChange={(event) => setSkipFutureConfirmations(event.target.checked)} />
          <span>{t("Don't show this confirmation again")}<small>{t('You can re-enable it anytime in Preferences.')}</small></span>
        </label>
        <div className="confirm-order-actions">
          <button className="confirm-back" data-dialog-autofocus onClick={() => setConfirming(false)}>{t('Go back')}</button>
          <button className={side === 'Buy' ? 'confirm-submit buy' : 'confirm-submit sell'} disabled={submitting}
            onClick={() => { if (skipFutureConfirmations) onSetConfirmOrders(false); void submitOrder(); }}>
            <strong>{submitting ? t('Submitting…') : `${t(side)} ${amount} ${asset}`}</strong>
            <span>{orderType === 'Limit' ? `@ ${price} ${quote}` : t('Market')} · {exchange.name}</span>
          </button>
        </div>
      </section>
    </div>}
    {notice && <div className={notice.kind === 'error' ? 'toast toast-error' : 'toast'} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.kind === 'error' ? '!' : '✓'}</span><div><strong>{notice.title}</strong><p>{notice.text}</p></div></div>}
  </>;
}

function VenueFromCode({ code }: { code: string }) {
  const exchange = exchanges.find((item) => item.id === code.toLowerCase());
  return <VenueCell id={code.toLowerCase()} name={exchange?.name ?? code} short={exchange?.short ?? code.slice(0, 2)} />;
}

function EmptyTable({ label }: { label: string }) {
  const { t } = useLanguage();
  return <div className="empty-state"><span>◎</span><strong>{t(`No ${label.toLowerCase()}`)}</strong><p>{t('The backend will add rows here as executions occur.')}</p></div>;
}

function ExecutionTables({ snapshot, portfolio, bottomTab, setBottomTab, expandedPosition, setExpandedPosition, onTradingChanged, onPositionsRefresh, notify, tradingMode, onOpenModeDialog }: {
  snapshot: TradingSnapshot | null;
  portfolio: AuthenticatedPortfolioSnapshot | null;
  bottomTab: string;
  setBottomTab: (tab: string) => void;
  expandedPosition: string | null;
  setExpandedPosition: (value: string | null) => void;
  onTradingChanged: () => Promise<void>;
  onPositionsRefresh: () => Promise<void>;
  notify: (kind: 'ok' | 'error', title: string, text: string) => void;
  tradingMode: TradingMode | null;
  onOpenModeDialog: () => void;
}) {
  const { t } = useLanguage();
  const [cancellingIds, setCancellingIds] = useState<string[]>([]);
  const [closeTargets, setCloseTargets] = useState<Position[] | null>(null);
  const [closingPosition, setClosingPosition] = useState(false);
  const closeDialogRef = useDialogFocus(Boolean(closeTargets), closingPosition ? undefined : () => setCloseTargets(null));
  const positions = snapshot?.positions.filter((position) => Number(position.quantity) !== 0) ?? [];
  const orders = snapshot?.orders ?? [];
  const openOrders = orders.filter((order) => OPEN_ORDER_STATES.includes(order.state));
  const fills = snapshot?.fills ?? [];
  const groups = Object.values(positions.reduce<Record<string, Position[]>>((result, position) => {
    const asset = symbolParts(position.symbol).asset;
    (result[asset] ??= []).push(position);
    return result;
  }, {}));
  const tabs = [`Positions (${positions.length})`, `Open orders (${openOrders.length})`, 'Order history', 'Trade history'];
  const active = bottomTab.startsWith('Positions') ? tabs[0] : bottomTab.startsWith('Open orders') ? tabs[1] : bottomTab;
  const notionalFor = (position: Position) => Math.abs(Number(position.quantity) * Number(position.mark_price));
  const portfolioPositions = portfolio?.snapshot.futuresPositions ?? [];
  const fundingFeeCell = (value: number | null, quote: string) => <td className={value !== null && value > 0 ? 'positive' : value !== null && value < 0 ? 'negative' : ''}>
    {value === null ? '—' : `${signedAmount(value)} ${quote}`}
  </td>;
  const closeVenueCount = closeTargets ? new Set(closeTargets.map((position) => symbolParts(position.symbol).venue)).size : 0;
  useEffect(() => {
    if (!active.startsWith('Positions') || positions.length === 0) return;
    let refreshInProgress = false;
    const timer = window.setInterval(() => {
      if (refreshInProgress) return;
      refreshInProgress = true;
      void onPositionsRefresh().catch(() => undefined).finally(() => { refreshInProgress = false; });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [active, positions.length, onPositionsRefresh]);
  const requestClose = (targets: Position[]) => {
    if (tradingMode !== 'live') {
      onOpenModeDialog();
      return;
    }
    setCloseTargets(targets);
  };
  const closePositions = async () => {
    if (!closeTargets || closingPosition) return;
    const targets = closeTargets;
    setClosingPosition(true);
    const positionMode = portfolio?.snapshot.account.positionMode;
    const results = await Promise.allSettled(targets.map((position) => {
      const portfolioPosition = portfolio?.snapshot.futuresPositions?.find((item) => item.positionId === position.position_id);
      const signedQuantity = Number(position.quantity);
      const inferredSide = signedQuantity >= 0 ? 'LONG' : 'SHORT';
      const positionSide = positionMode === 'DUAL'
        ? (portfolioPosition?.positionSide === 'LONG' || portfolioPosition?.positionSide === 'SHORT' ? portfolioPosition.positionSide : inferredSide)
        : 'NONE';
      return api.createOrder({
        symbol: position.symbol,
        side: signedQuantity >= 0 ? 'SELL' : 'BUY',
        type: 'MARKET',
        timeInForce: 'IOC',
        quantity: position.quantity.trim().replace(/^-/, ''),
        reduceOnly: true,
        positionSide,
      });
    }));
    const failures = results.filter((result) => result.status === 'rejected');
    try {
      await onTradingChanged();
    } catch {
      // The private execution stream will still reconcile accepted close orders.
    }
    if (failures.length === 0) {
      notify('ok', t('Close order submitted'), `${targets.length} · ${t('Market reduce-only')}`);
    } else {
      const firstFailure = failures[0] as PromiseRejectedResult;
      const detail = firstFailure.reason instanceof ApiError ? firstFailure.reason.message : t('Backend unavailable');
      notify('error', t(failures.length === targets.length ? 'Position close failed' : 'Some positions failed to close'), detail);
    }
    setClosingPosition(false);
    setCloseTargets(null);
  };
  // A silently failed cancel looks identical to a dead order — surface the failure and keep the
  // row locked while the request is in flight so a double click cannot fire twice.
  const cancel = async (order: ExecutionOrder) => {
    if (cancellingIds.includes(order.id)) return;
    setCancellingIds((current) => [...current, order.id]);
    try {
      await api.cancelOrder(order.id);
      notify('ok', t('Order cancelled'), `${symbolParts(order.symbol).asset} ${order.side} ${order.quantity} · ${order.remoteOrderId ?? order.clientOrderId}`);
      await onTradingChanged();
    } catch (error) {
      notify('error', t('Cancel failed'), error instanceof ApiError ? error.message : t('Backend unavailable'));
    } finally {
      setCancellingIds((current) => current.filter((id) => id !== order.id));
    }
  };
  return <section className="positions-panel terminal-panel">
    <div className="positions-head"><div className="panel-tabs">{tabs.map((tab) => { const match = tab.match(/^(.+?)( \(\d+\))?$/); return <button className={active === tab ? 'active' : ''} onClick={() => setBottomTab(tab)} key={tab}>{t(match?.[1] ?? tab)}{match?.[2] ?? ''}</button>; })}</div></div>
    {active.startsWith('Positions') && (groups.length ? <div className="positions-table table-wrap"><table><thead><tr><th>{t('Contract')}</th><th>{t('Exchange')}</th><th>{t('Size')}</th><th>{t('Position notional')}</th><th>{t('Entry price')}</th><th>{t('Mark price')}</th><th>{t('Unrealized PnL')}</th><th>{t('Realized PnL')}</th><th>{t('Funding fee')}</th><th>{t('Close position')}</th></tr></thead><tbody>{groups.map((legs) => {
      const asset = symbolParts(legs[0].symbol).asset;
      const quantity = legs.reduce((sum, leg) => sum + Number(leg.quantity), 0);
      const grossQuantity = legs.reduce((sum, leg) => sum + Math.abs(Number(leg.quantity)), 0);
      const grossNotional = legs.reduce((sum, leg) => sum + notionalFor(leg), 0);
      const venueCount = new Set(legs.map((leg) => symbolParts(leg.symbol).venue)).size;
      const pnl = legs.reduce((sum, leg) => sum + (Number(leg.mark_price) - Number(leg.entry_price)) * Number(leg.quantity), 0);
      const weightedEntryPrice = legs.reduce((sum, leg) => sum + Number(leg.entry_price) * Math.abs(Number(leg.quantity)), 0) / grossQuantity;
      const weightedMarkPrice = legs.reduce((sum, leg) => sum + Number(leg.mark_price) * Math.abs(Number(leg.quantity)), 0) / grossQuantity;
      const fullyHedged = grossQuantity > 0 && Math.abs(quantity) <= Math.max(1e-12, grossQuantity * 1e-9);
      const key = `${asset}-PERP`;
      if (legs.length === 1) {
        const leg = legs[0];
        const part = symbolParts(leg.symbol);
        return <tr key={key}><td><strong>{marketSymbol(part.asset, part.quote, 'perpetual')}</strong><small className={quantity >= 0 ? 'long-tag' : 'short-tag'}>{t(quantity >= 0 ? 'Long' : 'Short')}</small></td><td><VenueFromCode code={part.venue} /></td><td>{quantity.toFixed(4)} {part.asset}</td><td>{formatAmount(notionalFor(leg))} {part.quote}</td><td>{compactPrice(Number(leg.entry_price))}</td><td>{compactPrice(Number(leg.mark_price))}</td><td className={pnl >= 0 ? 'positive' : 'negative'}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} {part.quote}</td><td>{Number(leg.realized_pnl).toFixed(2)} {part.quote}</td>{fundingFeeCell(positionFundingFee(leg, portfolioPositions), part.quote)}<td><button className="row-action close-position-action" onClick={() => requestClose([leg])}>{t('Close position')}</button></td></tr>;
      }
      const aggregateFundingFee = aggregatePositionFundingFee(legs, portfolioPositions);
      return <Fragment key={key}><tr className="aggregate-row"><td><button className={expandedPosition === key ? 'expand-position expanded' : 'expand-position'} onClick={() => setExpandedPosition(expandedPosition === key ? null : key)}>›</button><strong>{asset} PERP</strong><small className={fullyHedged ? 'hedged-tag' : quantity >= 0 ? 'long-tag' : 'short-tag'}>{t(fullyHedged ? 'Hedged' : quantity >= 0 ? 'Long' : 'Short')}</small></td><td><span className="venue-group"><strong>{venueCount} {t(venueCount === 1 ? 'exchange' : 'exchanges')}</strong></span></td><td>{quantity.toFixed(4)} {asset}</td><td>${formatAmount(grossNotional)}</td><td>{compactPrice(weightedEntryPrice)}</td><td>{compactPrice(weightedMarkPrice)}</td><td className={pnl >= 0 ? 'positive' : 'negative'}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} USDT</td><td>{legs.reduce((sum, leg) => sum + Number(leg.realized_pnl), 0).toFixed(2)} USDT</td>{fundingFeeCell(aggregateFundingFee, 'USDT')}<td><button className="row-action close-position-action" onClick={() => requestClose(legs)}>{t('Close all')}</button></td></tr>{expandedPosition === key && legs.map((leg) => { const part = symbolParts(leg.symbol); const legPnl = (Number(leg.mark_price) - Number(leg.entry_price)) * Number(leg.quantity); return <tr className="position-leg" key={leg.symbol}><td><span className="leg-branch">↳</span><strong>{marketSymbol(part.asset, part.quote, 'perpetual')}</strong><small>{t('Venue leg')}</small></td><td><VenueFromCode code={part.venue} /></td><td>{Number(leg.quantity).toFixed(4)} {part.asset}</td><td>{formatAmount(notionalFor(leg))} {part.quote}</td><td>{compactPrice(Number(leg.entry_price))}</td><td>{compactPrice(Number(leg.mark_price))}</td><td className={legPnl >= 0 ? 'positive' : 'negative'}>{legPnl >= 0 ? '+' : ''}{legPnl.toFixed(2)} {part.quote}</td><td>{Number(leg.realized_pnl).toFixed(2)} {part.quote}</td>{fundingFeeCell(positionFundingFee(leg, portfolioPositions), part.quote)}<td><button className="row-action close-position-action" onClick={() => requestClose([leg])}>{t('Close position')}</button></td></tr>; })}</Fragment>;
    })}</tbody></table></div> : <EmptyTable label="positions" />)}
    {active.startsWith('Open orders') && (openOrders.length ? <OrderTable orders={openOrders} cancellable onCancel={cancel} busyOrderIds={cancellingIds} /> : <EmptyTable label="open orders" />)}
    {active === 'Order history' && (orders.length ? <OrderTable orders={orders} onCancel={cancel} busyOrderIds={cancellingIds} /> : <EmptyTable label="order history" />)}
    {active === 'Trade history' && (fills.length ? <FillTable fills={fills} /> : <EmptyTable label="trade history" />)}
    {closeTargets && <div className="modal-backdrop confirm-order-backdrop" role="presentation" onMouseDown={() => { if (!closingPosition) setCloseTargets(null); }}>
      <section ref={closeDialogRef} tabIndex={-1} className="confirm-order-modal close-position-modal" role="dialog" aria-modal="true" aria-labelledby="close-position-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><p className="eyebrow negative">{t('Close position')}</p><h2 id="close-position-title">{t('Confirm close position')}</h2><span className="confirm-market">{closeTargets.length === 1 ? marketSymbol(symbolParts(closeTargets[0].symbol).asset, symbolParts(closeTargets[0].symbol).quote, 'perpetual') : `${symbolParts(closeTargets[0].symbol).asset} PERP`} · {closeVenueCount} {t(closeVenueCount === 1 ? 'exchange' : 'exchanges')}</span></div>
          <button className="disclaimer-close" aria-label={t('Close')} onClick={() => setCloseTargets(null)} disabled={closingPosition}>×</button>
        </header>
        <dl className="confirm-order-summary">
          <div><dt>{t('Positions to close')}</dt><dd>{closeTargets.length}</dd></div>
          <div><dt>{t('Size')}</dt><dd>{formatAmount(closeTargets.reduce((sum, position) => sum + Math.abs(Number(position.quantity)), 0), 4)} {symbolParts(closeTargets[0].symbol).asset}</dd></div>
          <div><dt>{t('Position notional')}</dt><dd>${formatAmount(closeTargets.reduce((sum, position) => sum + notionalFor(position), 0))}</dd></div>
          <div><dt>{t('Execution')}</dt><dd>{t('Market reduce-only')}</dd></div>
        </dl>
        <p className="close-position-warning">{t('Close position warning')}</p>
        <div className="confirm-order-actions">
          <button className="confirm-back" data-dialog-autofocus onClick={() => setCloseTargets(null)} disabled={closingPosition}>{t('Go back')}</button>
          <button className="confirm-submit sell" onClick={() => void closePositions()} disabled={closingPosition}><strong>{closingPosition ? t('Closing position…') : t('Confirm close')}</strong><span>{t('Market reduce-only')}</span></button>
        </div>
      </section>
    </div>}
  </section>;
}

function OrderTable({ orders, cancellable = false, onCancel, busyOrderIds }: { orders: ExecutionOrder[]; cancellable?: boolean; onCancel: (order: ExecutionOrder) => Promise<void>; busyOrderIds: string[] }) {
  const { language, t } = useLanguage();
  return <div className="positions-table table-wrap"><table><thead><tr><th>{t('Time')}</th><th>{t('Contract')}</th><th>{t('Exchange')}</th><th>{t('Side / Type')}</th><th>{t('Price')}</th><th>{t('Amount')}</th><th>{t('Filled')}</th><th>{t('Status')}</th><th>{t('Order ID')}</th>{cancellable && <th />}</tr></thead><tbody>{orders.map((order) => { const part = symbolParts(order.symbol); const busy = busyOrderIds.includes(order.id); return <tr key={order.id}><td>{new Date(order.createdAt).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US')}</td><td><strong>{marketSymbol(part.asset, part.quote, 'perpetual')}</strong>{order.strategyId && <small className="long-tag">{order.strategyId}</small>}</td><td><VenueFromCode code={part.venue} /></td><td><small className={order.side === 'BUY' ? 'long-tag' : 'short-tag'}>{t(order.side === 'BUY' ? 'Buy' : 'Sell')} · {t(order.type === 'LIMIT' ? 'Limit' : 'Market')}</small></td><td>{order.executedAveragePrice ?? order.price ?? t('Market')}</td><td>{order.quantity} {part.asset}</td><td>{order.executedQuantity}</td><td><span className={`status-tag ${order.state.toLowerCase()}`}>{order.state}</span></td><td>{order.remoteOrderId ?? order.clientOrderId}</td>{cancellable && <td><button className="row-action" onClick={() => void onCancel(order)} disabled={busy}>{busy ? t('Cancelling…') : t('Cancel')}</button></td>}</tr>; })}</tbody></table></div>;
}

function FillTable({ fills }: { fills: ExecutionFill[] }) {
  const { language, t } = useLanguage();
  return <div className="positions-table table-wrap"><table><thead><tr><th>{t('Time')}</th><th>{t('Contract')}</th><th>{t('Exchange')}</th><th>{t('Side')}</th><th>{t('Execution price')}</th><th>{t('Size')}</th><th>{t('Fee')}</th><th>{t('Realized PnL')}</th><th>{t('Trade ID')}</th></tr></thead><tbody>{fills.map((fill) => { const part = symbolParts(fill.symbol); return <tr key={fill.id}><td>{new Date(fill.created_at).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US')}</td><td><strong>{marketSymbol(part.asset, part.quote, 'perpetual')}</strong></td><td><VenueFromCode code={part.venue} /></td><td><small className={fill.side === 'BUY' ? 'long-tag' : 'short-tag'}>{t(fill.side === 'BUY' ? 'Buy' : 'Sell')}</small></td><td>{fill.price}</td><td>{fill.quantity} {part.asset}</td><td>{Number(fill.fee).toFixed(4)}</td><td>{Number(fill.realized_pnl).toFixed(2)}</td><td>{fill.id.slice(0, 12)}</td></tr>; })}</tbody></table></div>;
}

/** Formats the max-size column: explicit totals for position/auto, levels × per-order for grids. */
