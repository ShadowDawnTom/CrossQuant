-- 交易主表只保存最新监控摘要，完整时间线单独落表，避免前端轮询时扫描大量历史。
-- @ensure-column funding_arbitrage_trades monitor_state TEXT NOT NULL DEFAULT 'PENDING'
-- @ensure-column funding_arbitrage_trades last_monitor_at TEXT
-- @ensure-column funding_arbitrage_trades soft_review_at TEXT
-- @ensure-column funding_arbitrage_trades hard_deadline_at TEXT
-- @ensure-column funding_arbitrage_trades next_settlement_at TEXT
-- @ensure-column funding_arbitrage_trades current_exit_pnl TEXT
-- @ensure-column funding_arbitrage_trades hold_value TEXT
-- @ensure-column funding_arbitrage_trades current_basis_bps TEXT
-- @ensure-column funding_arbitrage_trades funding_edge TEXT
-- @ensure-column funding_arbitrage_trades unprofitable_count INTEGER NOT NULL DEFAULT 0
-- @ensure-column funding_arbitrage_trades last_monitor_reason TEXT
-- @ensure-column funding_arbitrage_trades cumulative_actual_funding TEXT NOT NULL DEFAULT '0'

CREATE TABLE IF NOT EXISTS funding_rate_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  funding_rate TEXT NOT NULL,
  funding_time INTEGER NOT NULL,
  funding_interval INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(symbol, observed_at)
);

CREATE INDEX IF NOT EXISTS funding_rate_snapshots_symbol_time_idx
  ON funding_rate_snapshots(symbol, observed_at DESC);

CREATE TABLE IF NOT EXISTS funding_holding_evaluations (
  id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  market_quality TEXT NOT NULL,
  long_rate TEXT,
  short_rate TEXT,
  funding_edge TEXT,
  conservative_funding TEXT,
  risk_buffer TEXT,
  hold_value TEXT,
  current_exit_pnl TEXT,
  basis_bps TEXT,
  exit_slippage_bps TEXT,
  unprofitable_count INTEGER NOT NULL DEFAULT 0,
  next_settlement_at TEXT,
  settlement_events_json TEXT NOT NULL DEFAULT '[]',
  details_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (trade_id) REFERENCES funding_arbitrage_trades(id)
);

CREATE INDEX IF NOT EXISTS funding_holding_evaluations_trade_time_idx
  ON funding_holding_evaluations(trade_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS funding_expected_settlements (
  id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  venue TEXT NOT NULL,
  funding_time TEXT NOT NULL,
  expected_amount TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING',
  account_book_id TEXT,
  actual_amount TEXT,
  reconciled_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(trade_id, symbol, funding_time),
  UNIQUE(account_book_id),
  FOREIGN KEY (trade_id) REFERENCES funding_arbitrage_trades(id)
);

CREATE INDEX IF NOT EXISTS funding_expected_settlements_trade_time_idx
  ON funding_expected_settlements(trade_id, funding_time DESC);
