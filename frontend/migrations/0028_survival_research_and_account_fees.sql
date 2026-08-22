-- @ensure-column funding_scan_observations horizon_scenarios_json TEXT
-- @ensure-column funding_scan_observations selected_horizon_hours INTEGER
-- @ensure-column funding_scan_observations survival_weighted_net_pnl TEXT
-- @ensure-column funding_scan_observations survival_weighted_annualized TEXT
-- @ensure-column funding_research_settlements actual_rate TEXT
-- @ensure-column funding_discovery_snapshots pool TEXT NOT NULL DEFAULT 'SATELLITE'

-- 这里只保存账户实际返回的费率，不保存 Key、Secret 或任何签名材料。
CREATE TABLE IF NOT EXISTS funding_fee_diagnostics (
  venue TEXT PRIMARY KEY,
  spot_maker_fee TEXT NOT NULL,
  spot_taker_fee TEXT NOT NULL,
  spot_rpi_maker_fee TEXT,
  future_maker_fee TEXT NOT NULL,
  future_taker_fee TEXT NOT NULL,
  future_rpi_maker_fee TEXT,
  special_fee_count INTEGER NOT NULL DEFAULT 0,
  special_rpi_count INTEGER NOT NULL DEFAULT 0,
  special_fees_json TEXT NOT NULL DEFAULT '[]',
  observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS funding_research_settlements_due_realized_idx
  ON funding_research_settlements(state, funding_time);
