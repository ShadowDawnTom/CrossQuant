CREATE TABLE IF NOT EXISTS execution_market_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sampled_at TEXT NOT NULL,
  base TEXT NOT NULL,
  long_venue TEXT NOT NULL,
  short_venue TEXT NOT NULL,
  quality TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  exchange_skew_ms INTEGER,
  receive_skew_ms INTEGER,
  long_ask TEXT,
  short_bid TEXT
);

CREATE INDEX IF NOT EXISTS execution_market_samples_pair_time_idx
  ON execution_market_samples(base, long_venue, short_venue, sampled_at DESC);
