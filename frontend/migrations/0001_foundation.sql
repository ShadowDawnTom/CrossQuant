CREATE TABLE IF NOT EXISTS user_preferences (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS credential_metadata (id TEXT PRIMARY KEY, label TEXT NOT NULL, provider TEXT NOT NULL, created_at TEXT NOT NULL, last_verified_at TEXT);
CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, type TEXT NOT NULL, correlation_id TEXT, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS risk_rules (id TEXT PRIMARY KEY, scope TEXT NOT NULL, metric TEXT NOT NULL, limit_value TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS hedge_strategies (id TEXT PRIMARY KEY, environment TEXT NOT NULL, state TEXT NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hedge_legs (id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL REFERENCES hedge_strategies(id), venue TEXT NOT NULL, product_type TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, target_quantity TEXT NOT NULL, state TEXT NOT NULL);
