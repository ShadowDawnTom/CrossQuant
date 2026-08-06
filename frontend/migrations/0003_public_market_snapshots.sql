CREATE TABLE IF NOT EXISTS public_market_snapshots (
  symbol TEXT PRIMARY KEY,
  venue TEXT NOT NULL,
  product TEXT NOT NULL,
  bid_price TEXT,
  ask_price TEXT,
  last_price TEXT,
  mark_price TEXT NOT NULL,
  index_price TEXT NOT NULL,
  funding_rate TEXT NOT NULL,
  predicted_funding_rate TEXT,
  next_funding_at TEXT NOT NULL,
  source_timestamp TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  source TEXT NOT NULL
);
