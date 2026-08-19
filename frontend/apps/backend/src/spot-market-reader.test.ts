import { describe, expect, it, vi } from 'vitest';
import { SpotMarketReader } from './spot-market-reader.js';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SpotMarketReader', () => {
  it('normalizes Gate, Binance, and OKX BBO payloads and caches the result', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('gateio')) return jsonResponse({ bids: [['99', '2']], asks: [['101', '3']] });
      if (url.includes('binance')) return jsonResponse({ bids: [['98', '4']], asks: [['102', '5']] });
      return jsonResponse({ data: [{ bids: [['97', '6']], asks: [['103', '7']] }] });
    }) as unknown as typeof fetch;
    const reader = new SpotMarketReader(fetchImpl);

    await expect(reader.query('GATE', 'sol')).resolves.toMatchObject({
      venue: 'GATE', base: 'SOL', bidPrice: '99', bidSize: '2', askPrice: '101', askSize: '3',
    });
    await reader.query('GATE', 'SOL');
    await expect(reader.query('BINANCE', 'SOL')).resolves.toMatchObject({ bidPrice: '98', askPrice: '102' });
    await expect(reader.query('OKX', 'SOL')).resolves.toMatchObject({ bidPrice: '97', askPrice: '103' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails closed for crossed or unsupported spot books', async () => {
    const crossed = vi.fn(async () => jsonResponse({ bids: [['101', '2']], asks: [['100', '3']] })) as unknown as typeof fetch;
    const reader = new SpotMarketReader(crossed);

    await expect(reader.query('GATE', 'SOL')).rejects.toThrow('spot_book_invalid');
    await expect(reader.query('BYBIT', 'SOL')).rejects.toThrow('spot_venue_not_supported');
  });
});
