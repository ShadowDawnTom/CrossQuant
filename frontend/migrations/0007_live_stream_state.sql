CREATE TABLE IF NOT EXISTS live_positions (
  position_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  venue TEXT NOT NULL,
  quantity TEXT NOT NULL,
  entry_price TEXT NOT NULL,
  mark_price TEXT NOT NULL,
  realized_pnl TEXT NOT NULL DEFAULT '0',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS live_positions_symbol_idx ON live_positions(symbol, updated_at DESC);
