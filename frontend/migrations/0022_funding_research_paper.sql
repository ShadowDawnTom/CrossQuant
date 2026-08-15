CREATE TABLE IF NOT EXISTS funding_scan_observations (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  asset TEXT NOT NULL,
  long_venue TEXT NOT NULL,
  short_venue TEXT NOT NULL,
  quantity TEXT,
  status TEXT NOT NULL,
  strict_eligible INTEGER NOT NULL DEFAULT 0,
  research_eligible INTEGER NOT NULL DEFAULT 0,
  primary_reason TEXT NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  market_quality TEXT,
  long_rate TEXT NOT NULL,
  short_rate TEXT NOT NULL,
  long_events INTEGER NOT NULL,
  short_events INTEGER NOT NULL,
  entry_long_price TEXT,
  entry_short_price TEXT,
  exit_long_price TEXT,
  exit_short_price TEXT,
  entry_long_notional TEXT,
  entry_short_notional TEXT,
  raw_funding_pnl TEXT,
  conservative_funding_pnl TEXT,
  immediate_round_trip_pnl TEXT,
  entry_fees TEXT,
  exit_fees TEXT,
  trading_fees TEXT,
  stress_buffer TEXT,
  net_pnl TEXT,
  raw_annualized TEXT,
  net_annualized TEXT,
  break_even_hours TEXT,
  entry_slippage_bps TEXT,
  exit_slippage_bps TEXT,
  basis_bps TEXT
);

CREATE INDEX IF NOT EXISTS funding_scan_observations_time_idx
  ON funding_scan_observations(observed_at DESC);

CREATE INDEX IF NOT EXISTS funding_scan_observations_status_time_idx
  ON funding_scan_observations(status, observed_at DESC);

CREATE INDEX IF NOT EXISTS funding_scan_observations_pair_time_idx
  ON funding_scan_observations(asset, long_venue, short_venue, observed_at DESC);

CREATE TABLE IF NOT EXISTS funding_research_positions (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL UNIQUE,
  asset TEXT NOT NULL,
  long_venue TEXT NOT NULL,
  short_venue TEXT NOT NULL,
  quantity TEXT NOT NULL,
  target_notional_usd TEXT NOT NULL,
  state TEXT NOT NULL,
  monitor_state TEXT NOT NULL DEFAULT 'PENDING',
  entry_raw_annualized TEXT NOT NULL,
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
  current_basis_bps TEXT,
  entry_slippage_bps TEXT,
  exit_slippage_bps TEXT,
  settled_events INTEGER NOT NULL DEFAULT 0,
  data_failure_count INTEGER NOT NULL DEFAULT 0,
  next_settlement_at TEXT,
  last_reason TEXT,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  last_evaluated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (observation_id) REFERENCES funding_scan_observations(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS funding_research_one_open_position_idx
  ON funding_research_positions(state)
  WHERE state = 'OPEN';

CREATE INDEX IF NOT EXISTS funding_research_positions_state_time_idx
  ON funding_research_positions(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS funding_research_evaluations (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  market_quality TEXT NOT NULL,
  current_exit_pnl TEXT,
  price_pnl TEXT,
  funding_pnl TEXT,
  exit_fees TEXT,
  basis_bps TEXT,
  exit_slippage_bps TEXT,
  settled_events INTEGER NOT NULL DEFAULT 0,
  next_settlement_at TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (position_id) REFERENCES funding_research_positions(id)
);

CREATE INDEX IF NOT EXISTS funding_research_evaluations_position_time_idx
  ON funding_research_evaluations(position_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS funding_research_settlements (
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
  FOREIGN KEY (position_id) REFERENCES funding_research_positions(id)
);

CREATE INDEX IF NOT EXISTS funding_research_settlements_position_time_idx
  ON funding_research_settlements(position_id, funding_time DESC);
