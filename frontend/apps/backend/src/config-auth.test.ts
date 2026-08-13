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
});
