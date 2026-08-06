-- Closed candles persisted per symbol+interval so chart history survives restarts and
-- timeframe switches serve from local data instead of waiting on venue REST backfills.
CREATE TABLE IF NOT EXISTS candle_cache (
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  open TEXT NOT NULL,
  high TEXT NOT NULL,
  low TEXT NOT NULL,
  close TEXT NOT NULL,
  volume TEXT NOT NULL,
  PRIMARY KEY (symbol, interval, start_time)
);
