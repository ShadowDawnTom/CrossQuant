-- Legacy bootstrap databases predate correlation_id. The migration runner applies this
-- checksummed directive transactionally and only when the column is absent.
-- @ensure-column audit_events correlation_id TEXT

CREATE INDEX IF NOT EXISTS audit_events_created_idx
  ON audit_events(created_at DESC);

CREATE INDEX IF NOT EXISTS execution_strategies_status_updated_idx
  ON execution_strategies(status, updated_at);

CREATE INDEX IF NOT EXISTS execution_strategy_logs_created_idx
  ON execution_strategy_logs(created_at);

CREATE INDEX IF NOT EXISTS funding_history_coverage_recent_idx
  ON funding_history_coverage(last_success_at DESC, last_attempt_at DESC);
