-- Realized funding settlements are persisted locally so rolling funding totals survive restarts
-- and venue APIs only need to supply missing/stale ranges.
CREATE TABLE IF NOT EXISTS funding_rate_history (
  symbol TEXT NOT NULL,
  funding_time INTEGER NOT NULL,
  rate TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (symbol, funding_time)
);

CREATE INDEX IF NOT EXISTS funding_rate_history_symbol_time_idx
  ON funding_rate_history(symbol, funding_time DESC);

-- Coverage is stored even for ranges containing no settlements. Without it, an empty but
-- successful history response would be downloaded again on every page visit.
CREATE TABLE IF NOT EXISTS funding_history_coverage (
  symbol TEXT PRIMARY KEY,
  covered_from INTEGER NOT NULL,
  covered_to INTEGER NOT NULL,
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error_code TEXT
);
