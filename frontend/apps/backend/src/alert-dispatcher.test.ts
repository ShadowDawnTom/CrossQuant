import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertDispatcher } from './alert-dispatcher.js';
import { openDatabase } from './database.js';

const cleanup: Array<{ database: ReturnType<typeof openDatabase>; directory: string }> = [];

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'alerts-'));
  const result = openDatabase(join(directory, 'test.sqlite'), resolve(process.cwd(), '../../migrations'));
  cleanup.push({ database: result, directory });
  return result;
}

afterEach(() => {
  for (const item of cleanup.splice(0)) {
    item.database.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

describe('AlertDispatcher Telegram', () => {
  it('发送 Telegram 普通文本且不把 Token 写入数据库', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const db = database();
    const dispatcher = new AlertDispatcher(db, { webhookUrl: null, fetchImpl: fetchImpl as typeof fetch,
      telegram: { botToken: 'bot-secret', chatId: '-100123', timeoutMs: 1000 } });
    expect(await dispatcher.emit({ eventType: 'service_test', severity: 'info', message: '告警通道测试成功' })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(calls[0]?.url).toContain('/botbot-secret/sendMessage');
    const body = JSON.parse(calls[0]?.body ?? '{}') as { chat_id: string; text: string };
    expect(body).toMatchObject({ chat_id: '-100123' });
    expect(body.text).toContain('告警通道测试成功');
    const stored = JSON.stringify(db.prepare('SELECT * FROM operational_alerts').all());
    expect(stored).not.toContain('bot-secret');
    expect(stored).toContain('DELIVERED');
  });

  it('Telegram 429 后按 retry_after 重试', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ parameters: { retry_after: 1 } }), { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const dispatcher = new AlertDispatcher(database(), { webhookUrl: null, fetchImpl: fetchImpl as typeof fetch,
        telegram: { botToken: 'token', chatId: '-100123' } });
      const pending = dispatcher.emit({ eventType: 'retry', severity: 'warning', message: 'retry' });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
