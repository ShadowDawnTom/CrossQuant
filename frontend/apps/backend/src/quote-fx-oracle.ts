import { Decimal } from 'decimal.js';

export const EXECUTION_QUOTES = ['USD', 'USDC', 'USDT'] as const;
export type ExecutionQuote = typeof EXECUTION_QUOTES[number];

export interface QuoteFxSnapshot {
  quote: ExecutionQuote;
  usdRate: string | null;
  observedAt: string | null;
  ageMs: number | null;
  state: 'healthy' | 'stale' | 'depegged' | 'unavailable';
}

export interface QuoteFxReader {
  start(): void;
  stop(): void;
  rate(quote: ExecutionQuote, now?: number): QuoteFxSnapshot;
}

interface MutableRate {
  usdRate: string;
  observedAt: number;
}

export interface StablecoinFxOracleOptions {
  refreshMs?: number;
  staleMs?: number;
  maxPegDeviationBps?: number;
  endpoint?: string;
  coinbaseEndpoint?: string;
  gateEndpoint?: string;
  now?: () => number;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function midpoint(row: unknown): string | null {
  const value = object(row);
  const ask = Array.isArray(value?.a) ? Number(value.a[0]) : Number.NaN;
  const bid = Array.isArray(value?.b) ? Number(value.b[0]) : Number.NaN;
  if (!Number.isFinite(ask) || !Number.isFinite(bid) || ask <= 0 || bid <= 0 || ask < bid) return null;
  return new Decimal(ask).plus(bid).div(2).toString();
}

/**
 * 将 USDT、USDC 折算成 USD。价格跨报价币比较前必须经过这一层；
 * 数据过期或偏离 1 美元过大时直接停止认证，不能假设稳定币永远等于 1。
 */
export class StablecoinFxOracle implements QuoteFxReader {
  private readonly refreshMs: number;
  private readonly staleMs: number;
  private readonly maxPegDeviationBps: number;
  private readonly endpoint: string;
  private readonly coinbaseEndpoint: string;
  private readonly gateEndpoint: string;
  private readonly now: () => number;
  private readonly rates = new Map<ExecutionQuote, MutableRate>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight: Promise<void> | null = null;

  constructor(private readonly fetchImpl: typeof fetch = fetch, options: StablecoinFxOracleOptions = {}) {
    this.refreshMs = options.refreshMs ?? 10_000;
    this.staleMs = options.staleMs ?? 30_000;
    this.maxPegDeviationBps = options.maxPegDeviationBps ?? 100;
    this.endpoint = options.endpoint ?? 'https://api.kraken.com/0/public/Ticker?pair=USDTUSD,USDCUSD';
    this.coinbaseEndpoint = options.coinbaseEndpoint ?? 'https://api.coinbase.com/v2/exchange-rates';
    this.gateEndpoint = options.gateEndpoint ?? 'https://api.gateio.ws/api/v4/spot/tickers';
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  rate(quote: ExecutionQuote, now = this.now()): QuoteFxSnapshot {
    if (quote === 'USD') {
      return { quote, usdRate: '1', observedAt: new Date(now).toISOString(), ageMs: 0, state: 'healthy' };
    }
    const rate = this.rates.get(quote);
    if (!rate) return { quote, usdRate: null, observedAt: null, ageMs: null, state: 'unavailable' };
    const ageMs = Math.max(0, now - rate.observedAt);
    const deviationBps = new Decimal(rate.usdRate).minus(1).abs().mul(10_000);
    const state = ageMs > this.staleMs ? 'stale'
      : deviationBps.gt(this.maxPegDeviationBps) ? 'depegged'
        : 'healthy';
    return {
      quote,
      usdRate: state === 'healthy' ? rate.usdRate : null,
      observedAt: new Date(rate.observedAt).toISOString(),
      ageMs,
      state,
    };
  }

  private refresh(): Promise<void> {
    this.refreshInFlight ??= (async () => {
      let usdt: string | null = null;
      let usdc: string | null = null;
      try {
        const response = await this.fetchImpl(this.endpoint, { signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw new Error(`quote_fx_http_${response.status}`);
        const result = object(object(await response.json())?.result);
        usdt = midpoint(result?.USDTZUSD ?? result?.USDTUSD);
        usdc = midpoint(result?.USDCUSD);
        if (!usdt || !usdc) throw new Error('quote_fx_schema_invalid');
      } catch {
        // Kraken 在部分网络区域不可达时使用 Coinbase 官方公开汇率，仍不回退到固定 1 美元。
        try {
          const headers = { Accept: 'application/json', 'User-Agent': 'CrossQuant/1.0' };
          const [usdtResponse, usdcResponse] = await Promise.all([
            this.fetchImpl(`${this.coinbaseEndpoint}?currency=USDT`, { headers, signal: AbortSignal.timeout(8_000) }),
            this.fetchImpl(`${this.coinbaseEndpoint}?currency=USDC`, { headers, signal: AbortSignal.timeout(8_000) }),
          ]);
          if (!usdtResponse.ok || !usdcResponse.ok) throw new Error('quote_fx_fallback_http_error');
          const readUsd = async (response: Response): Promise<string | null> => {
            const data = object(object(await response.json())?.data);
            return positiveRate(object(data?.rates)?.USD);
          };
          [usdt, usdc] = await Promise.all([readUsd(usdtResponse), readUsd(usdcResponse)]);
        } catch {
          // 最后使用 Gate 可达的 USDT/USD 与 USDC/USDT 双边盘口交叉换算，仍保留真实相对脱锚变化。
          const [usdtResponse, usdcUsdtResponse] = await Promise.all([
            this.fetchImpl(`${this.gateEndpoint}?currency_pair=USDT_USD`, { signal: AbortSignal.timeout(8_000) }),
            this.fetchImpl(`${this.gateEndpoint}?currency_pair=USDC_USDT`, { signal: AbortSignal.timeout(8_000) }),
          ]);
          if (!usdtResponse.ok || !usdcUsdtResponse.ok) throw new Error('quote_fx_gate_fallback_http_error');
          const gateMidpoint = async (response: Response): Promise<string | null> => {
            const payload = await response.json() as unknown;
            const row = Array.isArray(payload) ? object(payload[0]) : null;
            return midpoint({ a: [row?.lowest_ask], b: [row?.highest_bid] });
          };
          const [usdtUsd, usdcUsdt] = await Promise.all([gateMidpoint(usdtResponse), gateMidpoint(usdcUsdtResponse)]);
          usdt = usdtUsd;
          usdc = usdtUsd && usdcUsdt ? new Decimal(usdtUsd).mul(usdcUsdt).toString() : null;
        }
      }
      if (!usdt || !usdc) throw new Error('quote_fx_schema_invalid');
      const observedAt = this.now();
      this.rates.set('USDT', { usdRate: usdt, observedAt });
      this.rates.set('USDC', { usdRate: usdc, observedAt });
    })().catch(() => undefined).finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }
}

function positiveRate(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const rate = new Decimal(String(value));
    return rate.isFinite() && rate.isPositive() ? rate.toString() : null;
  } catch {
    return null;
  }
}

/** 测试和离线回放使用固定汇率；生产服务使用上面的实时预言机。 */
export class StaticQuoteFxReader implements QuoteFxReader {
  constructor(private readonly rates: Partial<Record<ExecutionQuote, string>> = { USD: '1', USDC: '1', USDT: '1' }) {}
  start(): void {}
  stop(): void {}
  rate(quote: ExecutionQuote, now = Date.now()): QuoteFxSnapshot {
    const usdRate = this.rates[quote] ?? null;
    return { quote, usdRate, observedAt: usdRate ? new Date(now).toISOString() : null,
      ageMs: usdRate ? 0 : null, state: usdRate ? 'healthy' : 'unavailable' };
  }
}
