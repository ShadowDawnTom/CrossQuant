import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('browser authentication config', () => {
  it('fails closed when OAuth credentials are incomplete', () => {
    expect(() => loadConfig({
      GCT_AUTH_ENABLED: '1',
      GCT_AUTH_BASE_URL: 'https://crossquant.shadowdawn.xyz',
      GCT_AUTH_ALLOWED_EMAILS: 'owner@example.com',
      GCT_AUTH_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    })).toThrow('Google OAuth credentials are required');
  });

  it('requires HTTPS, a strong session secret and a non-empty allowlist', () => {
    const base = {
      GCT_AUTH_ENABLED: '1', GCT_GOOGLE_CLIENT_ID: 'id', GCT_GOOGLE_CLIENT_SECRET: 'secret',
      GCT_AUTH_ALLOWED_EMAILS: 'owner@example.com', GCT_AUTH_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    };
    expect(() => loadConfig({ ...base, GCT_AUTH_BASE_URL: 'http://crossquant.shadowdawn.xyz' })).toThrow('must use https');
    expect(() => loadConfig({ ...base, GCT_AUTH_BASE_URL: 'https://crossquant.shadowdawn.xyz', GCT_AUTH_SESSION_SECRET: 'short' })).toThrow('at least 32 bytes');
    expect(() => loadConfig({ ...base, GCT_AUTH_BASE_URL: 'https://crossquant.shadowdawn.xyz', GCT_AUTH_ALLOWED_EMAILS: '' })).toThrow('at least one email');
  });

  it('normalizes the two configured email addresses', () => {
    const config = loadConfig({
      GCT_AUTH_ENABLED: '1', GCT_AUTH_BASE_URL: 'https://crossquant.shadowdawn.xyz',
      GCT_GOOGLE_CLIENT_ID: 'id', GCT_GOOGLE_CLIENT_SECRET: 'secret',
      GCT_AUTH_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
      GCT_AUTH_ALLOWED_EMAILS: ' OWNER@EXAMPLE.COM, operator@example.com ',
    });
    expect([...config.browserAuth.allowedEmails]).toEqual(['owner@example.com', 'operator@example.com']);
  });

  it('rejects zero-valued funding scanner intervals and leverage', () => {
    expect(() => loadConfig({ GCT_FUNDING_SCAN_INTERVAL_MS: '0' })).toThrow('must be greater than zero');
    expect(() => loadConfig({ GCT_FUNDING_LEVERAGE: '0' })).toThrow('must be greater than zero');
  });

  it('Telegram Token 和 Chat ID 必须成对配置', () => {
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: 'token-only' })).toThrow('must be configured together');
    expect(loadConfig({ TELEGRAM_ALERT_ENABLED: '0', TELEGRAM_BOT_TOKEN: 'ignored' }).riskLimits.telegramBotToken).toBeNull();
  });

  it('资金费保留系数只能在零到一之间', () => {
    expect(() => loadConfig({ GCT_FUNDING_RETENTION_FACTOR: '1.1' })).toThrow('must be between zero and one');
    expect(loadConfig({ GCT_FUNDING_RETENTION_FACTOR: '0.5' }).fundingArbitrage.fundingRetentionFactor).toBe('0.5');
  });

  it('探索发现池可以大于完整盘口池', () => {
    const config = loadConfig({
      GCT_EXECUTION_MARKET_SYMBOLS: 'BTC,ETH',
      GCT_FUNDING_RESEARCH_ENABLED: '1',
      GCT_FUNDING_RESEARCH_ASSETS: 'BTC,DOGE',
    });
    expect(config.executionMarket.symbols).toEqual(['BTC', 'ETH']);
    expect(config.fundingResearch.assets).toEqual(['BTC', 'DOGE']);
  });

  it('探索模拟每个实验组最多同时三组持仓', () => {
    expect(() => loadConfig({ GCT_FUNDING_RESEARCH_MAX_OPEN_POSITIONS: '4' }))
      .toThrow('between 1 and 3');
    expect(loadConfig({
      GCT_EXECUTION_MARKET_SYMBOLS: 'BTC,ETH,SOL,DOGE,TRUMP',
      GCT_FUNDING_RESEARCH_ENABLED: '1',
      GCT_FUNDING_RESEARCH_ASSETS: 'BTC,ETH,SOL,DOGE,TRUMP',
    }).fundingResearch).toMatchObject({
      enabled: true,
      modelVersion: 'rolling_v4',
      assets: ['BTC', 'ETH', 'SOL', 'DOGE', 'TRUMP'],
      targetNotionalUsd: '5',
      maxActualNotionalUsd: '10',
      maxOpenPositions: 3,
      discoveryHotPoolSize: 10,
      rollingHoldExitConfirmations: 60,
      rollingReversalExitConfirmations: 30,
      reentryCooldownMs: 43_200_000,
      holdStressSlippageBps: '2',
      holdAdverseExitBasisBps: '3',
    });
    expect(() => loadConfig({ GCT_FUNDING_RESEARCH_MODEL_VERSION: 'Rolling V4' }))
      .toThrow('must use lowercase letters');
  });
});
