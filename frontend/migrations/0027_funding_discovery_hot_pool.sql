-- 广域发现只保存轻量 REST 快照；完整盘口仍只存在于动态热池内。
CREATE TABLE IF NOT EXISTS funding_discovery_snapshots (
  id TEXT PRIMARY KEY,
  sweep_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  asset TEXT NOT NULL,
  best_long_venue TEXT,
  best_short_venue TEXT,
  best_long_rate TEXT,
  best_short_rate TEXT,
  spread_8h TEXT,
  open_interest_usd TEXT,
  last_price TEXT,
  change_24h TEXT,
  edge_started_at TEXT,
  direction_flips_24h INTEGER NOT NULL DEFAULT 0,
  consecutive_confirmations INTEGER NOT NULL DEFAULT 0,
  eligible_for_hot_pool INTEGER NOT NULL DEFAULT 0,
  in_hot_pool INTEGER NOT NULL DEFAULT 0,
  primary_reason TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS funding_discovery_snapshots_sweep_idx
  ON funding_discovery_snapshots(sweep_id, asset);

CREATE INDEX IF NOT EXISTS funding_discovery_snapshots_asset_time_idx
  ON funding_discovery_snapshots(asset, observed_at DESC);

CREATE INDEX IF NOT EXISTS funding_discovery_snapshots_time_idx
  ON funding_discovery_snapshots(observed_at DESC);

-- 模拟盘可以同时研究多个不同组合，但同一方向组合不能被重复开仓。
DROP INDEX IF EXISTS funding_research_one_open_position_per_cohort_idx;

CREATE UNIQUE INDEX IF NOT EXISTS funding_research_unique_open_pair_per_cohort_idx
  ON funding_research_positions(cohort, research_model_version, asset, long_venue, short_venue)
  WHERE state = 'OPEN';
