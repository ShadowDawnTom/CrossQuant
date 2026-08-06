import { useEffect, useMemo, useRef, useState } from 'react';
import { marketSymbol } from './market-symbol.js';
import { quoteForStrategyVenue, rankStrategyAssetOptions, type StrategyAssetOption } from './strategy-asset-options.js';

function contractLabel(option: StrategyAssetOption): string {
  const left = marketSymbol(option.asset, option.leftQuote, 'perpetual');
  const right = marketSymbol(option.asset, option.rightQuote, 'perpetual');
  return option.leftQuote === option.rightQuote ? `${left} PERP` : `${left} ↔ ${right}`;
}

interface StrategyAssetSearchProps {
  asset: string;
  options: StrategyAssetOption[];
  loading: boolean;
  leftVenueId: string;
  rightVenueId: string;
  leftVenueName: string;
  rightVenueName: string;
  onSelect: (asset: string) => void;
  t: (key: string) => string;
}

export function StrategyAssetSearch({
  asset,
  options,
  loading,
  leftVenueId,
  rightVenueId,
  leftVenueName,
  rightVenueName,
  onSelect,
  t,
}: StrategyAssetSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const listId = 'strategy-contract-options';
  const selected = options.find((option) => option.asset === asset) ?? {
    asset,
    leftQuote: quoteForStrategyVenue(leftVenueId),
    rightQuote: quoteForStrategyVenue(rightVenueId),
    streamed: true,
  };
  const rows = useMemo(
    () => rankStrategyAssetOptions(options, query, asset),
    [asset, options, query],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [open, query]);

  function choose(nextAsset: string) {
    onSelect(nextAsset);
    setOpen(false);
    setQuery('');
  }

  function moveHighlight(next: number) {
    const bounded = Math.max(0, Math.min(next, rows.length - 1));
    setHighlight(bounded);
    listRef.current?.children[bounded]?.scrollIntoView({ block: 'nearest' });
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      moveHighlight(event.key === 'ArrowDown' ? highlight + 1 : highlight - 1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setOpen(true);
      moveHighlight(event.key === 'Home' ? 0 : rows.length - 1);
    } else if (event.key === 'Enter' && open && rows[highlight]) {
      event.preventDefault();
      choose(rows[highlight].asset);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      setQuery('');
      inputRef.current?.focus();
    }
  }

  return <div className={`strategy-asset-search${open ? ' open' : ''}`} ref={rootRef}>
    <span className="strategy-asset-search-label">{t('Contract')}</span>
    <div className="strategy-asset-search-control" onClick={() => inputRef.current?.focus()}>
      <span aria-hidden="true">⌕</span>
      <input
        ref={inputRef}
        type="search"
        value={query}
        placeholder={contractLabel(selected)}
        autoComplete="off"
        role="combobox"
        aria-label={t('Search asset')}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && rows[highlight] ? `strategy-contract-${rows[highlight].asset}` : undefined}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={onInputKeyDown}
      />
      <span className="strategy-asset-search-chevron" aria-hidden="true">⌄</span>
    </div>
    {open && <div className="strategy-asset-search-menu">
      <div className="strategy-asset-search-meta">
        <span>{t('Market name')}</span>
        <small>{loading ? '…' : rows.length.toLocaleString('en-US')}</small>
      </div>
      <ul id={listId} role="listbox" aria-label={t('Contract')} ref={listRef}>
        {rows.map((option, index) => {
          const current = option.asset === asset;
          return <li
            id={`strategy-contract-${option.asset}`}
            key={option.asset}
            role="option"
            aria-selected={current}
            className={`${index === highlight ? 'highlighted' : ''}${current ? ' current' : ''}`}
            onMouseEnter={() => setHighlight(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              choose(option.asset);
            }}
          >
              <span className="strategy-asset-symbol">{option.asset.slice(0, 1)}</span>
              <span>
                <strong>{contractLabel(option)}</strong>
                <small>{leftVenueName} + {rightVenueName}{option.leftQuote === option.rightQuote ? '' : ` · ${option.leftQuote} ↔ ${option.rightQuote}`}</small>
              </span>
              <em>{current ? '✓' : 'PERP'}</em>
          </li>;
        })}
        {rows.length === 0 && <li className="strategy-asset-search-empty">
          {loading ? t('Loading instrument metadata…') : t('No matches')}
        </li>}
      </ul>
    </div>}
  </div>;
}
