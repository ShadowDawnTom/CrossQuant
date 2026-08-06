ALTER TABLE execution_orders ADD COLUMN strategy_id TEXT;
ALTER TABLE execution_orders ADD COLUMN strategy_leg TEXT;

CREATE INDEX IF NOT EXISTS execution_orders_strategy_idx
  ON execution_orders(strategy_id, created_at DESC);

ALTER TABLE execution_strategies ADD COLUMN filled_left TEXT NOT NULL DEFAULT '0';
ALTER TABLE execution_strategies ADD COLUMN filled_right TEXT NOT NULL DEFAULT '0';
ALTER TABLE execution_strategies ADD COLUMN open_position TEXT NOT NULL DEFAULT '0';

CREATE TABLE IF NOT EXISTS live_balances (
  venue TEXT NOT NULL,
  coin TEXT NOT NULL,
  balance TEXT NOT NULL DEFAULT '0',
  available_balance TEXT NOT NULL DEFAULT '0',
  equity TEXT NOT NULL DEFAULT '0',
  unrealized_pnl TEXT NOT NULL DEFAULT '0',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (venue, coin)
);
