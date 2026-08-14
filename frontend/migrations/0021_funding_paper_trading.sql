CREATE TABLE IF NOT EXISTS funding_paper_positions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL UNIQUE,
  asset TEXT NOT NULL,
  long_venue TEXT NOT NULL,
  short_venue TEXT NOT NULL,
  quantity TEXT NOT NULL,
  state TEXT NOT NULL,
  monitor_state TEXT NOT NULL DEFAULT 'PENDING',
  entry_net_annualized TEXT NOT NULL,
  entry_long_price TEXT NOT NULL,
  entry_short_price TEXT NOT NULL,
  entry_long_notional TEXT NOT NULL,
  entry_short_notional TEXT NOT NULL,
  exit_long_price TEXT,
  exit_short_price TEXT,
  entry_fees TEXT NOT NULL DEFAULT '0',
  exit_fees TEXT NOT NULL DEFAULT '0',
  funding_pnl TEXT NOT NULL DEFAULT '0',
  price_pnl TEXT NOT NULL DEFAULT '0',
  total_pnl TEXT NOT NULL DEFAULT '0',
  current_exit_pnl TEXT,
  hold_value TEXT,
  current_basis_bps TEXT,
  funding_edge TEXT,
  long_rate TEXT,
  short_rate TEXT,
  unprofitable_count INTEGER NOT NULL DEFAULT 0,
  data_failure_count INTEGER NOT NULL DEFAULT 0,
  next_settlement_at TEXT,
  last_reason TEXT,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  last_evaluated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES funding_arbitrage_candidates(id)
);

CREATE INDEX IF NOT EXISTS funding_paper_positions_state_time_idx
  ON funding_paper_positions(state, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS funding_paper_one_open_pair_idx
  ON funding_paper_positions(asset, long_venue, short_venue)
  WHERE state = 'OPEN';

CREATE TABLE IF NOT EXISTS funding_paper_evaluations (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL,
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
  FOREIGN KEY (position_id) REFERENCES funding_paper_positions(id)
);

CREATE INDEX IF NOT EXISTS funding_paper_evaluations_position_time_idx
  ON funding_paper_evaluations(position_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS funding_paper_settlements (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  venue TEXT NOT NULL,
  side TEXT NOT NULL,
  funding_time TEXT NOT NULL,
  funding_rate TEXT NOT NULL,
  notional_usd TEXT NOT NULL,
  expected_amount TEXT NOT NULL,
  amount TEXT,
  state TEXT NOT NULL DEFAULT 'PENDING',
  settled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(position_id, symbol, funding_time),
  FOREIGN KEY (position_id) REFERENCES funding_paper_positions(id)
);

CREATE INDEX IF NOT EXISTS funding_paper_settlements_position_time_idx
  ON funding_paper_settlements(position_id, funding_time DESC);
