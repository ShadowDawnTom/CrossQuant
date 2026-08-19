-- @ensure-column funding_scan_observations data_valid INTEGER NOT NULL DEFAULT 1
-- @ensure-column funding_scan_observations invalid_reason TEXT
-- @ensure-column funding_scan_observations persistence_probability TEXT
-- @ensure-column funding_scan_observations persistence_samples INTEGER NOT NULL DEFAULT 0
-- @ensure-column funding_scan_observations retention_factor_used TEXT
-- @ensure-column funding_scan_observations historical_edge_p10 TEXT
-- @ensure-column funding_scan_observations historical_edge_median TEXT
-- @ensure-column funding_scan_observations requested_notional_usd TEXT
-- @ensure-column funding_research_positions reopen_after TEXT
-- @ensure-column funding_research_settlements amount_source TEXT NOT NULL DEFAULT 'PREDICTED_SNAPSHOT'

-- 旧版出现正的“立即往返损益”只可能来自交叉盘口；保留原始记录，但从后续研究统计中隔离。
UPDATE funding_scan_observations
SET data_valid = 0, invalid_reason = 'crossed_order_book'
WHERE immediate_round_trip_pnl IS NOT NULL
  AND CAST(immediate_round_trip_pnl AS REAL) > 0;

CREATE INDEX IF NOT EXISTS funding_scan_observations_valid_time_idx
  ON funding_scan_observations(data_valid, observed_at DESC);

CREATE TABLE IF NOT EXISTS funding_research_variants (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  variant TEXT NOT NULL,
  hedge_model TEXT NOT NULL,
  state TEXT NOT NULL,
  expected_net_pnl TEXT,
  expected_net_annualized TEXT,
  trading_fees TEXT,
  fill_probability TEXT,
  break_even_hours TEXT,
  reason TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(observation_id, variant),
  FOREIGN KEY (observation_id) REFERENCES funding_scan_observations(id)
);

CREATE INDEX IF NOT EXISTS funding_research_variants_time_idx
  ON funding_research_variants(evaluated_at DESC, variant);
