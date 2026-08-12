import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const SESSION_COOKIE = '__Host-crossquant_session';
const STATE_COOKIE = '__Host-crossquant_oauth_state';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;

interface SignedPayload { email: string; expiresAt: number }
interface GoogleTokenInfo { aud?: string; email?: string; email_verified?: string; exp?: string }

export interface BrowserAuthConfig {
  enabled: boolean;
  baseUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  sessionSecret: string;
  allowedEmails: ReadonlySet<string>;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('base64url');
}

function signedValue(payload: SignedPayload, secret: string): string {
  const body = encode(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

function verifySignedValue(value: string | undefined, secret: string, nowMs = Date.now()): SignedPayload | null {
  if (!value) return null;
  const [body, signature, extra] = value.split('.');
  if (!body || !signature || extra) return null;
  const expected = sign(body, secret);
  const left = Buffer.from(signature, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<SignedPayload>;
    if (typeof payload.email !== 'string' || typeof payload.expiresAt !== 'number' || payload.expiresAt <= nowMs) return null;
    return { email: payload.email, expiresAt: payload.expiresAt };
  } catch {
    return null;
  }
}

function cookies(request: FastifyRequest): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of (request.headers.cookie ?? '').split(';')) {
    const index = item.indexOf('=');
    if (index <= 0) continue;
    try {
      result.set(item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1).trim()));
    } catch {
      // 畸形 Cookie 按未登录处理，不能让任意请求把鉴权 Hook 打成 500。
    }
  }
  return result;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function loginPage(error?: string): string {
  const notice = error ? `<p class="error">${error}</p>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CrossQuant 登录</title><style>body{margin:0;background:#07110f;color:#e8f5f1;font:16px system-ui;display:grid;place-items:center;min-height:100vh}.card{width:min(420px,calc(100% - 40px));padding:32px;border:1px solid #244a42;border-radius:16px;background:#0c1d19;box-shadow:0 24px 80px #0008}h1{margin:0 0 12px}p{color:#9ebbb3;line-height:1.6}.error{color:#ff9aa9}a{display:block;margin-top:24px;padding:13px;text-align:center;border-radius:9px;background:#35e6bd;color:#04231c;font-weight:750;text-decoration:none}</style></head><body><main class="card"><h1>CrossQuant</h1><p>这是受保护的交易系统。仅已批准的 Google 账号可以访问。</p>${notice}<a href="/auth/google">使用 Google 登录</a></main></body></html>`;
}

/** Google OAuth 登录与服务端签名会话；所有权限判断都在后端完成。 */
export class BrowserAuth {
  constructor(private readonly config: BrowserAuthConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  isExempt(pathname: string): boolean {
    return pathname === '/auth/login' || pathname === '/auth/google' || pathname === '/auth/google/callback';
  }

  currentEmail(request: FastifyRequest): string | null {
    if (!this.config.enabled) return null;
    const payload = verifySignedValue(cookies(request).get(SESSION_COOKIE), this.config.sessionSecret);
    const email = payload?.email.toLowerCase();
    return email && this.config.allowedEmails.has(email) ? email : null;
  }

  guard(request: FastifyRequest, reply: FastifyReply): FastifyReply | void {
    if (!this.config.enabled || this.isExempt(request.url.split('?', 1)[0] ?? request.url)) return;
    if (this.currentEmail(request)) return;
    const pathname = request.url.split('?', 1)[0] ?? request.url;
    if (pathname.startsWith('/api/') || pathname === '/health' || request.headers.upgrade === 'websocket') {
      return reply.code(401).send({ error: 'authentication_required' });
    }
    return reply.redirect('/auth/login');
  }

  renderLogin(reply: FastifyReply, error?: string): FastifyReply {
    return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(loginPage(error));
  }

  begin(reply: FastifyReply): FastifyReply {
    const state = randomBytes(32).toString('base64url');
    const stateCookie = signedValue({ email: state, expiresAt: Date.now() + STATE_TTL_SECONDS * 1_000 }, this.config.sessionSecret);
    const query = new URLSearchParams({
      client_id: this.config.googleClientId,
      redirect_uri: `${this.config.baseUrl}/auth/google/callback`,
      response_type: 'code', scope: 'openid email', state, access_type: 'online', prompt: 'select_account',
    });
    return reply.header('Set-Cookie', cookie(STATE_COOKIE, stateCookie, STATE_TTL_SECONDS))
      .redirect(`https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`);
  }

  async complete(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const query = request.query as { code?: string; state?: string; error?: string };
    const statePayload = verifySignedValue(cookies(request).get(STATE_COOKIE), this.config.sessionSecret);
    const expiredStateCookie = cookie(STATE_COOKIE, '', 0);
    if (query.error || !query.code || !query.state || statePayload?.email !== query.state) {
      return this.renderLogin(reply.header('Set-Cookie', expiredStateCookie).code(401), '登录请求无效或已经过期，请重试。');
    }
    const tokenResponse = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: new URLSearchParams({
        code: query.code, client_id: this.config.googleClientId, client_secret: this.config.googleClientSecret,
        redirect_uri: `${this.config.baseUrl}/auth/google/callback`, grant_type: 'authorization_code',
      }), signal: AbortSignal.timeout(8_000),
    });
    if (!tokenResponse.ok) return this.renderLogin(reply.header('Set-Cookie', expiredStateCookie).code(401), 'Google 登录验证失败，请重试。');
    const tokens = await tokenResponse.json() as { id_token?: string };
    if (!tokens.id_token) return this.renderLogin(reply.header('Set-Cookie', expiredStateCookie).code(401), 'Google 未返回身份令牌。');
    const infoResponse = await this.fetchImpl(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokens.id_token)}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!infoResponse.ok) return this.renderLogin(reply.header('Set-Cookie', expiredStateCookie).code(401), 'Google 身份令牌无效。');
    const info = await infoResponse.json() as GoogleTokenInfo;
    const email = info.email?.trim().toLowerCase();
    const expiry = Number(info.exp ?? 0) * 1_000;
    if (info.aud !== this.config.googleClientId || info.email_verified !== 'true' || !email || expiry <= Date.now()) {
      return this.renderLogin(reply.header('Set-Cookie', expiredStateCookie).code(401), 'Google 身份信息未通过验证。');
    }
    if (!this.config.allowedEmails.has(email)) {
      return this.renderLogin(reply.header('Set-Cookie', expiredStateCookie).code(403), '这个 Google 账号没有 CrossQuant 访问权限。');
    }
    const session = signedValue({ email, expiresAt: Date.now() + SESSION_TTL_SECONDS * 1_000 }, this.config.sessionSecret);
    return reply.header('Set-Cookie', [expiredStateCookie, cookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS)]).redirect('/');
  }

  logout(reply: FastifyReply): FastifyReply {
    return reply.header('Set-Cookie', cookie(SESSION_COOKIE, '', 0)).redirect('/auth/login');
  }
}
