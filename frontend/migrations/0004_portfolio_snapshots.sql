CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  remote_updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS portfolio_snapshots_fetched_at
  ON portfolio_snapshots(fetched_at DESC);
