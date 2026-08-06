CREATE TABLE IF NOT EXISTS hyperliquid_perp_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  native_names_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
