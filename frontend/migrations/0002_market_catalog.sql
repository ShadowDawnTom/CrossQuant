CREATE TABLE IF NOT EXISTS crossex_instruments (
  symbol TEXT PRIMARY KEY,
  exchange_type TEXT NOT NULL,
  business_type TEXT NOT NULL,
  state TEXT NOT NULL,
  min_size TEXT NOT NULL,
  min_notional TEXT,
  lot_size TEXT NOT NULL,
  tick_size TEXT NOT NULL,
  max_num_orders TEXT NOT NULL,
  max_market_size TEXT,
  max_limit_size TEXT,
  contract_size TEXT,
  liquidation_fee TEXT,
  default_leverage TEXT,
  delist_time TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS crossex_instruments_venue_product
  ON crossex_instruments(exchange_type, business_type, symbol);

CREATE TABLE IF NOT EXISTS market_data_sync (
  source TEXT PRIMARY KEY,
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error_code TEXT
);

CREATE TABLE IF NOT EXISTS crossex_risk_tiers (
  symbol TEXT NOT NULL,
  tier TEXT NOT NULL,
  min_risk_limit_value TEXT NOT NULL,
  max_risk_limit_value TEXT NOT NULL,
  quick_cal_amount TEXT NOT NULL,
  leverage_max TEXT NOT NULL,
  maintenance_rate TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (symbol, tier)
);
