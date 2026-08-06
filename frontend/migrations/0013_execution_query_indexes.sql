-- Private-stream order matching, strategy accounting, and terminal snapshots are hot paths.
-- These indexes avoid full ledger scans as a local installation accumulates execution history.
CREATE INDEX IF NOT EXISTS execution_orders_remote_order_idx
  ON execution_orders(remote_order_id)
  WHERE remote_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS execution_orders_environment_created_idx
  ON execution_orders(environment, created_at DESC);

CREATE INDEX IF NOT EXISTS execution_orders_environment_state_created_idx
  ON execution_orders(environment, state, created_at);

CREATE INDEX IF NOT EXISTS execution_orders_strategy_state_created_idx
  ON execution_orders(strategy_id, state, created_at)
  WHERE strategy_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS execution_fills_order_created_idx
  ON execution_fills(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS execution_fills_created_idx
  ON execution_fills(created_at DESC);
