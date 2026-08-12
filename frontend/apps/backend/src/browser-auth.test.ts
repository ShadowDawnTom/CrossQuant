import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { BrowserAuth, type BrowserAuthConfig } from './browser-auth.js';

const config: BrowserAuthConfig = {
  enabled: true,
  baseUrl: 'https://crossquant.shadowdawn.xyz',
  googleClientId: 'google-client-id',
  googleClientSecret: 'google-client-secret',
  sessionSecret: '0123456789abcdef0123456789abcdef',
  allowedEmails: new Set(['owner@example.com', 'operator@example.com']),
};

function cookieValue(header: string | string[] | undefined, name: string): string {
  const lines = Array.isArray(header) ? header : [header ?? ''];
  const line = lines.find((item) => item.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} cookie missing`);
  return line.split(';', 1)[0]!;
}

async function testApp(fetchImpl: typeof fetch = fetch) {
  const app = Fastify({ logger: false });
  const auth = new BrowserAuth(config, fetchImpl);
  app.addHook('onRequest', async (request, reply) => auth.guard(request, reply));
  app.get('/auth/login', async (_request, reply) => auth.renderLogin(reply));
  app.get('/auth/google', async (_request, reply) => auth.begin(reply));
  app.get('/auth/google/callback', async (request, reply) => auth.complete(request, reply));
  app.get('/', async () => ({ ok: true }));
  app.get('/api/private', async () => ({ secret: true }));
  return app;
}

describe('browser Google authentication', () => {
  it('redirects pages and rejects API access without a session', async () => {
    const app = await testApp();
    expect((await app.inject({ method: 'GET', url: '/' })).headers.location).toBe('/auth/login');
    const api = await app.inject({ method: 'GET', url: '/api/private' });
    expect(api.statusCode).toBe(401);
    expect(api.json()).toEqual({ error: 'authentication_required' });
    const malformed = await app.inject({ method: 'GET', url: '/api/private', headers: { cookie: '__Host-crossquant_session=%ZZ' } });
    expect(malformed.statusCode).toBe(401);
    await app.close();
  });

  it('accepts an allowed verified Google account and creates a hardened session', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ id_token: 'test-id-token' }), { status: 200 });
      return new Response(JSON.stringify({
        aud: config.googleClientId, email: 'OWNER@EXAMPLE.COM', email_verified: 'true',
        exp: String(Math.floor(Date.now() / 1_000) + 300),
      }), { status: 200 });
    }) as typeof fetch;
    const app = await testApp(fetchImpl);
    const begin = await app.inject({ method: 'GET', url: '/auth/google' });
    const redirect = new URL(begin.headers.location!);
    const state = redirect.searchParams.get('state')!;
    const stateCookie = cookieValue(begin.headers['set-cookie'], '__Host-crossquant_oauth_state');
    const complete = await app.inject({
      method: 'GET', url: `/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: stateCookie },
    });
    expect(complete.statusCode).toBe(302);
    expect(complete.headers.location).toBe('/');
    const sessionCookie = cookieValue(complete.headers['set-cookie'], '__Host-crossquant_session');
    expect(Array.isArray(complete.headers['set-cookie']) ? complete.headers['set-cookie'].join(';') : complete.headers['set-cookie'])
      .toContain('HttpOnly; Secure; SameSite=Lax');
    const api = await app.inject({ method: 'GET', url: '/api/private', headers: { cookie: sessionCookie } });
    expect(api.statusCode).toBe(200);
    await app.close();
  });

  it('rejects a valid Google account outside the email allowlist', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input) === 'https://oauth2.googleapis.com/token'
      ? new Response(JSON.stringify({ id_token: 'test-id-token' }), { status: 200 })
      : new Response(JSON.stringify({
        aud: config.googleClientId, email: 'outsider@gmail.com', email_verified: 'true',
        exp: String(Math.floor(Date.now() / 1_000) + 300),
      }), { status: 200 })) as typeof fetch;
    const app = await testApp(fetchImpl);
    const begin = await app.inject({ method: 'GET', url: '/auth/google' });
    const redirect = new URL(begin.headers.location!);
    const complete = await app.inject({
      method: 'GET', url: `/auth/google/callback?code=test-code&state=${encodeURIComponent(redirect.searchParams.get('state')!)}`,
      headers: { cookie: cookieValue(begin.headers['set-cookie'], '__Host-crossquant_oauth_state') },
    });
    expect(complete.statusCode).toBe(403);
    expect(complete.body).toContain('没有 CrossQuant 访问权限');
    expect(String(complete.headers['set-cookie'])).not.toContain('__Host-crossquant_session=');
    await app.close();
  });

  it('rejects callback state tampering before contacting Google', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const app = await testApp(fetchImpl);
    const response = await app.inject({ method: 'GET', url: '/auth/google/callback?code=x&state=forged' });
    expect(response.statusCode).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
    await app.close();
  });
});
