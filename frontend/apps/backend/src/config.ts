import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface BackendConfig {
  host: string;
  port: number;
  publicReadOnly: boolean;
  dataDir: string;
  databasePath: string;
  credentialEnvPath: string;
  migrationsDir: string;
  frontendDistPath: string;
  allowedOrigin: string;
  allowedOrigins: ReadonlySet<string>;
  allowedHosts: ReadonlySet<string>;
  browserAuth: {
    enabled: boolean;
    baseUrl: string;
    googleClientId: string;
    googleClientSecret: string;
    sessionSecret: string;
    allowedEmails: ReadonlySet<string>;
    traderEmails: ReadonlySet<string>;
  };
  gateRestBaseUrl: string;
  gatePublicWebSocketUrl: string;
  gatePrivateWebSocketUrl: string;
  executionMarket: {
    symbols: string[];
    maxBookAgeMs: number;
    maxExchangeSkewMs: number;
    maxReceiveSkewMs: number;
    endpoints: Partial<Record<'GATE' | 'BINANCE' | 'OKX' | 'BYBIT', { rest: string; websocket: string }>>;
  };
  riskLimits: {
    maxGrossExposureUsd: string;
    minAvailableMarginRatio: string;
    maxDailyLossUsd: string;
    maxPortfolioAgeMs: number;
    maxAdlRank: number | null;
    alertWebhookUrl: string | null;
  };
  fundingArbitrage: {
    enabled: boolean;
    maxNotionalPerLegUsd: string;
    maxConcurrentTrades: number;
    maxUnhedgedMs: number;
    maxNetBaseExposure: string;
    maxEntrySlippageBps: string;
    maxBasisBps: string;
    maxHoldingMs: number;
    confirmationCount: number;
    confirmationWindowMs: number;
    minNetAnnualized: string;
  };
}

function parsePort(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

function parseNonNegativeDecimal(value: string, name: string): string {
  if (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative decimal`);
  }
  return value;
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BackendConfig {
  const host = environment.GCT_HOST ?? '127.0.0.1';
  const port = parsePort(environment.PORT ?? environment.GCT_PORT ?? '17840', 'GCT_PORT');
  const frontendPort = parsePort(environment.GCT_FRONTEND_PORT ?? '5173', 'GCT_FRONTEND_PORT');
  const dataDir = resolve(environment.GCT_DATA_DIR ?? join(projectRoot, '.local-data'));
  const configuredHosts = (environment.GCT_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const allowedOrigin = environment.GCT_FRONTEND_ORIGIN ?? `http://127.0.0.1:${frontendPort}`;
  const authEnabled = environment.GCT_AUTH_ENABLED === '1';
  const authBaseUrl = (environment.GCT_AUTH_BASE_URL ?? allowedOrigin).replace(/\/$/, '');
  const googleClientId = environment.GCT_GOOGLE_CLIENT_ID?.trim() ?? '';
  const googleClientSecret = environment.GCT_GOOGLE_CLIENT_SECRET?.trim() ?? '';
  const sessionSecret = environment.GCT_AUTH_SESSION_SECRET?.trim() ?? '';
  const allowedEmails = new Set((environment.GCT_AUTH_ALLOWED_EMAILS ?? '')
    .split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));
  const traderEmails = new Set((environment.GCT_AUTH_TRADER_EMAILS ?? '')
    .split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));
  if (authEnabled) {
    if (!authBaseUrl.startsWith('https://')) throw new Error('GCT_AUTH_BASE_URL must use https when authentication is enabled');
    if (!googleClientId || !googleClientSecret) throw new Error('Google OAuth credentials are required when authentication is enabled');
    if (Buffer.byteLength(sessionSecret, 'utf8') < 32) throw new Error('GCT_AUTH_SESSION_SECRET must contain at least 32 bytes');
    if (allowedEmails.size === 0) throw new Error('GCT_AUTH_ALLOWED_EMAILS must contain at least one email');
    for (const email of traderEmails) {
      if (!allowedEmails.has(email)) throw new Error('GCT_AUTH_TRADER_EMAILS must be a subset of GCT_AUTH_ALLOWED_EMAILS');
    }
  }
  // Browsers send the loopback host the user actually typed; localhost, 127.0.0.1, and [::1]
  // variants of the local UI and backend are all the same trust domain.
  const loopbackOrigins = [frontendPort, port].flatMap((loopbackPort) => [
    `http://127.0.0.1:${loopbackPort}`,
    `http://localhost:${loopbackPort}`,
    `http://[::1]:${loopbackPort}`,
  ]);
  return {
    host,
    port,
    publicReadOnly: environment.GCT_PUBLIC_READONLY === '1',
    dataDir,
    databasePath: join(dataDir, 'gate-crossex.sqlite'),
    credentialEnvPath: resolve(environment.GCT_CREDENTIAL_ENV_PATH ?? join(projectRoot, '.env')),
    migrationsDir: resolve(environment.GCT_MIGRATIONS_DIR ?? join(projectRoot, 'migrations')),
    frontendDistPath: resolve(environment.GCT_FRONTEND_DIST_DIR ?? join(projectRoot, 'apps/frontend/dist')),
    allowedOrigin,
    allowedOrigins: new Set([allowedOrigin, ...loopbackOrigins]),
    allowedHosts: new Set(['127.0.0.1', 'localhost', '::1', ...configuredHosts]),
    browserAuth: {
      enabled: authEnabled, baseUrl: authBaseUrl, googleClientId, googleClientSecret, sessionSecret, allowedEmails, traderEmails,
    },
    gateRestBaseUrl: environment.GCT_GATE_REST_URL ?? 'https://api.gateio.ws/api/v4',
    gatePublicWebSocketUrl: environment.GCT_GATE_PUBLIC_WS_URL ?? 'wss://api.gateio.ws/ws/crossex/public',
    gatePrivateWebSocketUrl: environment.GCT_GATE_PRIVATE_WS_URL ?? 'wss://api.gateio.ws/ws/crossex',
    executionMarket: {
      symbols: [...new Set((environment.GCT_EXECUTION_MARKET_SYMBOLS ?? 'BTC,ETH')
        .split(',').map((item) => item.trim().toUpperCase()).filter(Boolean))],
      maxBookAgeMs: parseNonNegativeInteger(environment.GCT_EXECUTION_MAX_BOOK_AGE_MS ?? '1500', 'GCT_EXECUTION_MAX_BOOK_AGE_MS'),
      maxExchangeSkewMs: parseNonNegativeInteger(environment.GCT_EXECUTION_MAX_EXCHANGE_SKEW_MS ?? '750', 'GCT_EXECUTION_MAX_EXCHANGE_SKEW_MS'),
      maxReceiveSkewMs: parseNonNegativeInteger(environment.GCT_EXECUTION_MAX_RECEIVE_SKEW_MS ?? '750', 'GCT_EXECUTION_MAX_RECEIVE_SKEW_MS'),
      endpoints: {
        GATE: {
          rest: environment.GCT_GATE_FUTURES_REST_URL ?? 'https://api.gateio.ws/api/v4',
          websocket: environment.GCT_GATE_FUTURES_WS_URL ?? 'wss://fx-ws.gateio.ws/v4/ws/usdt',
        },
        BINANCE: {
          rest: environment.GCT_BINANCE_FUTURES_REST_URL ?? 'https://fapi.binance.com',
          websocket: environment.GCT_BINANCE_FUTURES_WS_URL ?? 'wss://fstream.binance.com/public/ws',
        },
        OKX: {
          rest: environment.GCT_OKX_REST_URL ?? 'https://openapi.okx.com',
          websocket: environment.GCT_OKX_WS_URL ?? 'wss://ws.okx.com:8443/ws/v5/public',
        },
        BYBIT: {
          rest: environment.GCT_BYBIT_REST_URL ?? 'https://api.bybit.com',
          websocket: environment.GCT_BYBIT_WS_URL ?? 'wss://stream.bybit.com/v5/public/linear',
        },
      },
    },
    riskLimits: {
      maxGrossExposureUsd: parseNonNegativeDecimal(environment.GCT_RISK_MAX_GROSS_EXPOSURE_USD ?? '10000', 'GCT_RISK_MAX_GROSS_EXPOSURE_USD'),
      minAvailableMarginRatio: parseNonNegativeDecimal(environment.GCT_RISK_MIN_AVAILABLE_MARGIN_RATIO ?? '0.25', 'GCT_RISK_MIN_AVAILABLE_MARGIN_RATIO'),
      maxDailyLossUsd: parseNonNegativeDecimal(environment.GCT_RISK_MAX_DAILY_LOSS_USD ?? '200', 'GCT_RISK_MAX_DAILY_LOSS_USD'),
      maxPortfolioAgeMs: parseNonNegativeInteger(environment.GCT_RISK_MAX_PORTFOLIO_AGE_MS ?? '360000', 'GCT_RISK_MAX_PORTFOLIO_AGE_MS'),
      maxAdlRank: environment.GCT_RISK_MAX_ADL_RANK === undefined
        ? null
        : parseNonNegativeInteger(environment.GCT_RISK_MAX_ADL_RANK, 'GCT_RISK_MAX_ADL_RANK'),
      alertWebhookUrl: environment.GCT_RISK_ALERT_WEBHOOK_URL?.trim() || null,
    },
    fundingArbitrage: {
      // 新状态机即使部署到生产也默认关闭，必须由运维显式设置开关和所有额度。
      enabled: environment.GCT_FUNDING_LIVE_ENABLED === '1',
      maxNotionalPerLegUsd: parseNonNegativeDecimal(environment.GCT_FUNDING_MAX_NOTIONAL_PER_LEG_USD ?? '0', 'GCT_FUNDING_MAX_NOTIONAL_PER_LEG_USD'),
      maxConcurrentTrades: parseNonNegativeInteger(environment.GCT_FUNDING_MAX_CONCURRENT_TRADES ?? '0', 'GCT_FUNDING_MAX_CONCURRENT_TRADES'),
      maxUnhedgedMs: parseNonNegativeInteger(environment.GCT_FUNDING_MAX_UNHEDGED_MS ?? '1500', 'GCT_FUNDING_MAX_UNHEDGED_MS'),
      maxNetBaseExposure: parseNonNegativeDecimal(environment.GCT_FUNDING_MAX_NET_BASE_EXPOSURE ?? '0', 'GCT_FUNDING_MAX_NET_BASE_EXPOSURE'),
      maxEntrySlippageBps: parseNonNegativeDecimal(environment.GCT_FUNDING_MAX_ENTRY_SLIPPAGE_BPS ?? '5', 'GCT_FUNDING_MAX_ENTRY_SLIPPAGE_BPS'),
      maxBasisBps: parseNonNegativeDecimal(environment.GCT_FUNDING_MAX_BASIS_BPS ?? '30', 'GCT_FUNDING_MAX_BASIS_BPS'),
      maxHoldingMs: parseNonNegativeInteger(environment.GCT_FUNDING_MAX_HOLDING_MS ?? '28800000', 'GCT_FUNDING_MAX_HOLDING_MS'),
      confirmationCount: parseNonNegativeInteger(environment.GCT_FUNDING_CONFIRMATION_COUNT ?? '3', 'GCT_FUNDING_CONFIRMATION_COUNT'),
      confirmationWindowMs: parseNonNegativeInteger(environment.GCT_FUNDING_CONFIRMATION_WINDOW_MS ?? '10000', 'GCT_FUNDING_CONFIRMATION_WINDOW_MS'),
      minNetAnnualized: parseNonNegativeDecimal(environment.GCT_FUNDING_MIN_NET_ANNUALIZED ?? '0.10', 'GCT_FUNDING_MIN_NET_ANNUALIZED'),
    },
  };
}
