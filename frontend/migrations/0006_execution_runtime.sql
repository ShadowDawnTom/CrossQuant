CREATE TABLE IF NOT EXISTS execution_orders (
  id TEXT PRIMARY KEY,
  remote_order_id TEXT,
  client_order_id TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL,
  symbol TEXT NOT NULL,
  venue TEXT NOT NULL,
  side TEXT NOT NULL,
  order_type TEXT NOT NULL,
  time_in_force TEXT NOT NULL,
  quantity TEXT NOT NULL,
  price TEXT,
  reduce_only INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  executed_quantity TEXT NOT NULL DEFAULT '0',
  executed_average_price TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS execution_orders_state_idx ON execution_orders(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS execution_fills (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES execution_orders(id),
  symbol TEXT NOT NULL,
  venue TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity TEXT NOT NULL,
  price TEXT NOT NULL,
  fee TEXT NOT NULL,
  realized_pnl TEXT NOT NULL DEFAULT '0',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_positions (
  symbol TEXT PRIMARY KEY,
  venue TEXT NOT NULL,
  quantity TEXT NOT NULL,
  entry_price TEXT NOT NULL,
  mark_price TEXT NOT NULL,
  realized_pnl TEXT NOT NULL DEFAULT '0',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_strategies (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  environment TEXT NOT NULL,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  filled_quantity TEXT NOT NULL DEFAULT '0',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_at TEXT
);

CREATE TABLE IF NOT EXISTS execution_strategy_logs (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES execution_strategies(id),
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  condition_text TEXT NOT NULL,
  quantity TEXT NOT NULL,
  result_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS execution_strategy_logs_strategy_idx
  ON execution_strategy_logs(strategy_id, created_at DESC);
