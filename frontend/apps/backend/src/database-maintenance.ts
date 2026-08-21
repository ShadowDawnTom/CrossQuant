import type Database from 'better-sqlite3';

const DAY_MS = 24 * 60 * 60_000;
const AUDIT_RETENTION_MS = 180 * DAY_MS;
const EXECUTION_RETENTION_MS = 365 * DAY_MS;
const MAX_AUDIT_EVENTS = 50_000;
const MARKET_SAMPLE_RETENTION_MS = 30 * DAY_MS;
const FUNDING_SNAPSHOT_RETENTION_MS = 30 * DAY_MS;
// 参数回放至少需要跨多个结算周期和不同波动日；严格池缩到主流币后，14 天原始候选量仍可控。
const FUNDING_SCAN_RETENTION_MS = 14 * DAY_MS;

export interface DatabaseMaintenanceResult {
  auditEventsDeleted: number;
  strategyLogsDeleted: number;
  fillsDeleted: number;
  ordersDeleted: number;
  executionMarketSamplesDeleted: number;
  fundingRateSnapshotsDeleted: number;
  fundingHoldingEvaluationsDeleted: number;
  fundingPaperEvaluationsDeleted: number;
  fundingScanObservationsDeleted: number;
  fundingDiscoverySnapshotsDeleted: number;
  fundingResearchEvaluationsDeleted: number;
}

/**
 * Bound locally generated operational data while preserving active strategy state. Execution
 * history is retained for a year; rows belonging to running, paused, or unresolved strategies
 * are never selected for pruning.
 */
export function runDatabaseMaintenance(
  database: Database.Database,
  now = Date.now(),
): DatabaseMaintenanceResult {
  const auditCutoff = new Date(now - AUDIT_RETENTION_MS).toISOString();
  const executionCutoff = new Date(now - EXECUTION_RETENTION_MS).toISOString();
  const marketSampleCutoff = new Date(now - MARKET_SAMPLE_RETENTION_MS).toISOString();
  const fundingSnapshotCutoff = new Date(now - FUNDING_SNAPSHOT_RETENTION_MS).toISOString();
  const fundingScanCutoff = new Date(now - FUNDING_SCAN_RETENTION_MS).toISOString();
  return database.transaction(() => {
    const expiredAudit = database.prepare('DELETE FROM audit_events WHERE created_at < ?').run(auditCutoff).changes;
    const excessAudit = database.prepare(`
      DELETE FROM audit_events WHERE id IN (
        SELECT id FROM audit_events ORDER BY created_at DESC LIMIT -1 OFFSET ?
      )
    `).run(MAX_AUDIT_EVENTS).changes;
    const strategyLogsDeleted = database.prepare(`
      DELETE FROM execution_strategy_logs
      WHERE created_at < ? AND strategy_id IN (
        SELECT id FROM execution_strategies WHERE status IN ('STOPPED', 'COMPLETED')
      )
    `).run(executionCutoff).changes;
    const eligibleOrderFilter = `
      updated_at < ?
          AND state IN (
            'FILLED',
            'CANCELLED',
            'REJECTED',
            'FAILED',
            'FAIL',
            'REMOTE_NOT_FOUND'
          )
      AND (
        strategy_id IS NULL OR strategy_id IN (
          SELECT id FROM execution_strategies WHERE status IN ('STOPPED', 'COMPLETED')
        )
      )
    `;
    const fillsDeleted = database.prepare(`
      DELETE FROM execution_fills WHERE order_id IN (
        SELECT id FROM execution_orders WHERE ${eligibleOrderFilter}
      )
    `).run(executionCutoff).changes;
    const ordersDeleted = database.prepare(`
      DELETE FROM execution_orders WHERE ${eligibleOrderFilter}
    `).run(executionCutoff).changes;
    const executionMarketSamplesDeleted = database.prepare(
      'DELETE FROM execution_market_samples WHERE sampled_at < ?',
    ).run(marketSampleCutoff).changes;
    const fundingRateSnapshotsDeleted = database.prepare(
      'DELETE FROM funding_rate_snapshots WHERE observed_at < ?',
    ).run(fundingSnapshotCutoff).changes;
    // 持仓判断属于交易审计证据，跟成交记录一样保留一年；实时费率快照只保留 30 天。
    const fundingHoldingEvaluationsDeleted = database.prepare(
      'DELETE FROM funding_holding_evaluations WHERE observed_at < ?',
    ).run(executionCutoff).changes;
    const fundingPaperEvaluationsDeleted = database.prepare(
      'DELETE FROM funding_paper_evaluations WHERE observed_at < ?',
    ).run(executionCutoff).changes;
    const fundingScanObservationsDeleted = database.prepare(
      'DELETE FROM funding_scan_observations WHERE observed_at < ? AND id NOT IN (SELECT observation_id FROM funding_research_positions)',
    ).run(fundingScanCutoff).changes;
    const fundingDiscoverySnapshotsDeleted = database.prepare(
      'DELETE FROM funding_discovery_snapshots WHERE observed_at < ?',
    ).run(fundingScanCutoff).changes;
    const fundingResearchEvaluationsDeleted = database.prepare(
      'DELETE FROM funding_research_evaluations WHERE observed_at < ?',
    ).run(executionCutoff).changes;
    return {
      auditEventsDeleted: expiredAudit + excessAudit,
      strategyLogsDeleted,
      fillsDeleted,
      ordersDeleted,
      executionMarketSamplesDeleted,
      fundingRateSnapshotsDeleted,
      fundingHoldingEvaluationsDeleted,
      fundingPaperEvaluationsDeleted,
      fundingScanObservationsDeleted,
      fundingDiscoverySnapshotsDeleted,
      fundingResearchEvaluationsDeleted,
    };
  })();
}
