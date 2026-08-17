import { describe, expect, it, vi } from 'vitest';
import { StablecoinFxOracle } from './quote-fx-oracle.js';

describe('StablecoinFxOracle', () => {
  it('使用双边中间价换算 USD，并在过期或脱锚时 fail-closed', async () => {
    let now = 1_800_000_000_000;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: {
      USDTZUSD: { a: ['1.0002'], b: ['0.9998'] },
      USDCUSD: { a: ['0.9801'], b: ['0.9799'] },
    } }), { status: 200 }));
    const oracle = new StablecoinFxOracle(fetchMock as typeof fetch, {
      now: () => now, staleMs: 30_000, maxPegDeviationBps: 100, refreshMs: 60_000,
    });

    oracle.start();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(oracle.rate('USDT').state).toBe('healthy'));
    expect(oracle.rate('USDT').usdRate).toBe('1');
    expect(oracle.rate('USDC')).toMatchObject({ state: 'depegged', usdRate: null });

    now += 30_001;
    expect(oracle.rate('USDT')).toMatchObject({ state: 'stale', usdRate: null });
    expect(oracle.rate('USD')).toMatchObject({ state: 'healthy', usdRate: '1' });
    oracle.stop();
  });

  it('Kraken 不可达时使用 Coinbase 公开汇率而不是固定按 1 美元', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('kraken')) throw new Error('blocked');
      const currency = new URL(url).searchParams.get('currency');
      return new Response(JSON.stringify({ data: { rates: { USD: currency === 'USDT' ? '0.9988' : '1' } } }),
        { status: 200 });
    });
    const oracle = new StablecoinFxOracle(fetchMock as typeof fetch, { refreshMs: 60_000 });

    oracle.start();
    await vi.waitFor(() => expect(oracle.rate('USDT').state).toBe('healthy'));
    expect(oracle.rate('USDT').usdRate).toBe('0.9988');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    oracle.stop();
  });

  it('前两个数据源都不可达时使用 Gate 盘口交叉汇率', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('kraken')) throw new Error('blocked');
      if (url.includes('coinbase')) return new Response('', { status: 503 });
      if (url.includes('USDT_USD')) return new Response(JSON.stringify([
        { lowest_ask: '0.9992', highest_bid: '0.9988' },
      ]), { status: 200 });
      return new Response(JSON.stringify([
        { lowest_ask: '1.0012', highest_bid: '1.0008' },
      ]), { status: 200 });
    });
    const oracle = new StablecoinFxOracle(fetchMock as typeof fetch, { refreshMs: 60_000 });

    oracle.start();
    await vi.waitFor(() => expect(oracle.rate('USDC').state).toBe('healthy'));
    expect(oracle.rate('USDT').usdRate).toBe('0.999');
    expect(oracle.rate('USDC').usdRate).toBe('0.999999');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    oracle.stop();
  });
});
