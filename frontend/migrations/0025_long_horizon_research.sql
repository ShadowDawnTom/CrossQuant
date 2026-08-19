-- @ensure-column funding_scan_observations research_model_version TEXT NOT NULL DEFAULT 'ROLLING_V1'
-- @ensure-column funding_research_positions research_model_version TEXT NOT NULL DEFAULT 'ROLLING_V1'
-- @ensure-column funding_research_positions reversal_count INTEGER NOT NULL DEFAULT 0
-- @ensure-column funding_research_variants research_model_version TEXT NOT NULL DEFAULT 'ROLLING_V1'

-- 迁移指令只允许大写默认常量；落库后统一成 API 使用的小写版本号。
UPDATE funding_scan_observations SET research_model_version = 'rolling_v1'
WHERE research_model_version = 'ROLLING_V1';
UPDATE funding_research_positions SET research_model_version = 'rolling_v1'
WHERE research_model_version = 'ROLLING_V1';
UPDATE funding_research_variants SET research_model_version = 'rolling_v1'
WHERE research_model_version = 'ROLLING_V1';

-- 新模型从干净账本起跑，但旧记录全部保留。这里只归档旧版未关闭模拟仓位，绝不影响真实持仓。
UPDATE funding_research_settlements
SET state = 'CANCELLED', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE state = 'PENDING'
  AND position_id IN (
    SELECT id FROM funding_research_positions
    WHERE state = 'OPEN' AND research_model_version <> 'rolling_v2'
  );

UPDATE funding_research_positions
SET state = 'CLOSED',
    monitor_state = 'EXIT',
    total_pnl = COALESCE(current_exit_pnl, total_pnl),
    last_reason = 'research_model_restarted',
    closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE state = 'OPEN' AND research_model_version <> 'rolling_v2';

CREATE INDEX IF NOT EXISTS funding_research_positions_model_time_idx
  ON funding_research_positions(research_model_version, opened_at DESC);
