-- @ensure-column funding_scan_observations long_quote TEXT NOT NULL DEFAULT 'USDT'
-- @ensure-column funding_scan_observations short_quote TEXT NOT NULL DEFAULT 'USDT'
-- @ensure-column funding_scan_observations long_quote_to_usd TEXT
-- @ensure-column funding_scan_observations short_quote_to_usd TEXT
-- @ensure-column funding_scan_observations liquidity_usd TEXT
-- @ensure-column funding_scan_observations execution_support TEXT NOT NULL DEFAULT 'LIVE_READY'
-- @ensure-column funding_scan_observations cohort_clone INTEGER NOT NULL DEFAULT 0
-- @ensure-column funding_scan_observations stablecoin_risk_buffer TEXT
-- @ensure-column funding_research_positions cohort TEXT NOT NULL DEFAULT 'ONE_SETTLEMENT'
-- @ensure-column funding_research_positions unprofitable_count INTEGER NOT NULL DEFAULT 0
-- @ensure-column funding_research_positions long_quote TEXT NOT NULL DEFAULT 'USDT'
-- @ensure-column funding_research_positions short_quote TEXT NOT NULL DEFAULT 'USDT'

DROP INDEX IF EXISTS funding_research_one_open_position_idx;

CREATE UNIQUE INDEX IF NOT EXISTS funding_research_one_open_position_per_cohort_idx
  ON funding_research_positions(cohort, state)
  WHERE state = 'OPEN';

CREATE INDEX IF NOT EXISTS funding_scan_observations_liquidity_time_idx
  ON funding_scan_observations(execution_support, observed_at DESC);
