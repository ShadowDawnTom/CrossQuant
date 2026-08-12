CREATE TABLE IF NOT EXISTS funding_arbitrage_trades (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  asset TEXT NOT NULL,
  long_venue TEXT NOT NULL,
  short_venue TEXT NOT NULL,
  requested_quantity TEXT NOT NULL,
  open_quantity TEXT NOT NULL DEFAULT '0',
  state TEXT NOT NULL,
  phase TEXT NOT NULL,
  execution_mode TEXT NOT NULL,
  long_order_id TEXT,
  short_order_id TEXT,
  repair_order_id TEXT,
  entry_long_price TEXT,
  entry_short_price TEXT,
  exit_long_price TEXT,
  exit_short_price TEXT,
  fees_paid TEXT NOT NULL DEFAULT '0',
  realized_pnl TEXT NOT NULL DEFAULT '0',
  expected_funding TEXT,
  actual_funding TEXT,
  failure_reason TEXT,
  manual_reason TEXT,
  opened_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS funding_arbitrage_candidates (
  id TEXT PRIMARY KEY,
  candidate_key TEXT NOT NULL UNIQUE,
  asset TEXT NOT NULL,
  long_venue TEXT NOT NULL,
  short_venue TEXT NOT NULL,
  quantity TEXT NOT NULL,
  long_rate TEXT NOT NULL,
  short_rate TEXT NOT NULL,
  net_annualized TEXT NOT NULL,
  confirmation_count INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS funding_arbitrage_candidates_state_idx
  ON funding_arbitrage_candidates(state, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS funding_arbitrage_state_idx
  ON funding_arbitrage_trades(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS funding_arbitrage_events (
  id TEXT PRIMARY KEY,
  trade_id TEXT,
  severity TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (trade_id) REFERENCES funding_arbitrage_trades(id)
);

CREATE INDEX IF NOT EXISTS funding_arbitrage_events_trade_idx
  ON funding_arbitrage_events(trade_id, created_at DESC);

CREATE TABLE IF NOT EXISTS operational_alerts (
  id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL,
  severity TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  delivery_state TEXT NOT NULL,
  delivery_error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS operational_alerts_created_idx
  ON operational_alerts(created_at DESC);
