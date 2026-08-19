import { Decimal } from 'decimal.js';
import type { ExecutionVenue } from './execution-market-hub.js';

export interface SpotBookSnapshot {
  venue: ExecutionVenue;
  base: string;
  bidPrice: string;
  bidSize: string;
  askPrice: string;
  askSize: string;
  receivedAt: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function level(value: unknown): readonly [string, string] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const price = String(value[0]);
  const size = String(value[1]);
  try {
    if (!new Decimal(price).gt(0) || !new Decimal(size).gt(0)) return null;
    return [price, size];
  } catch {
    return null;
  }
}

/**
 * 只给影子现金套利提供同所现货 BBO，不参与真实下单。
 * 目前限定 Gate、Binance、OKX，未验证的交易所保持 fail-closed。
 */
export class SpotMarketReader {
  private readonly cache = new Map<string, { expiresAt: number; value: SpotBookSnapshot }>();

  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly cacheMs = 15_000) {}

  async query(venue: ExecutionVenue, base: string): Promise<SpotBookSnapshot> {
    if (!['GATE', 'BINANCE', 'OKX'].includes(venue)) throw new Error('spot_venue_not_supported');
    const normalized = base.toUpperCase();
    const key = `${venue}:${normalized}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt >= Date.now()) return cached.value;
    let url: string;
    if (venue === 'GATE') {
      url = `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${normalized}_USDT&limit=5`;
    } else if (venue === 'BINANCE') {
      url = `https://api.binance.com/api/v3/depth?symbol=${normalized}USDT&limit=5`;
    } else {
      url = `https://www.okx.com/api/v5/market/books?instId=${normalized}-USDT&sz=5`;
    }
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`spot_book_http_${response.status}`);
    const payload = object(await response.json());
    const row = venue === 'OKX' && Array.isArray(payload?.data) ? object(payload.data[0]) : payload;
    const bid = level(Array.isArray(row?.bids) ? row.bids[0] : null);
    const ask = level(Array.isArray(row?.asks) ? row.asks[0] : null);
    if (!bid || !ask || !new Decimal(bid[0]).lt(ask[0])) throw new Error('spot_book_invalid');
    const value = { venue, base: normalized, bidPrice: bid[0], bidSize: bid[1], askPrice: ask[0], askSize: ask[1],
      receivedAt: new Date().toISOString() };
    this.cache.set(key, { expiresAt: Date.now() + this.cacheMs, value });
    return value;
  }
}
