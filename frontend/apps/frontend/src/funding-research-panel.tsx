import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type FundingResearchEvaluation, type FundingResearchSettlement,
  type FundingResearchSummary } from './api.js';

function decimal(value: string | null | undefined, digits = 4): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '—';
}

function percent(value: string | null | undefined, digits = 2): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed >= 0 ? '+' : ''}${(parsed * 100).toFixed(digits)}%` : '—';
}

function time(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString('zh-CN', { hour12: false }) : '—';
}

const reasonLabel: Record<string, string> = {
  funding_net_return_below_threshold: '净年化未达实盘门槛', strict_asset_not_enabled: '不在实盘扫描白名单',
  research_asset_not_enabled: '不在研究资产范围', market_not_synchronized: '盘口未同步',
  market_pair_unavailable: '盘口不可用', insufficient_executable_depth: '四向深度不足',
  research_entry_slippage_exceeded: '研究入场滑点超限', research_exit_slippage_exceeded: '研究退出滑点超限',
  fee_rate_missing: '账户费率缺失', instrument_rule_missing: '合约规则缺失', instrument_not_live: '合约未开放',
  top_of_book_missing: '最优报价缺失', invalid_quantity_rule: '数量规则异常',
  invalid_executable_notional: '可执行名义金额异常', raw_funding_not_positive: '原始资金费优势不为正',
  live_threshold_passed: '达到实盘候选标准', research_liquidity_passed: '通过研究流动性检查',
  research_liquidity_below_threshold: '10bp 四向深度不足', quote_fx_unavailable: '稳定币汇率不可用或脱锚',
  executor_venue_not_supported: '组合含暂未接入实盘执行器的交易所',
  research_waiting_first_settlement: '等待至少一次资金费结算',
  research_minimum_settlement_completed: '已经历最低结算数，按市场价退出',
  funding_or_fee_missing: '资金费或费率数据缺失', execution_pair_unavailable: '退出行情不可用',
  market_not_live_synchronized: '退出行情未同步', exit_depth_insufficient: '退出深度不足',
  hold_value_positive: '下一结算窗口保守价值为正', hold_value_confirmation_pending: '继续持有价值等待连续确认',
  hold_value_not_positive: '继续持有价值连续不为正', funding_direction_reversed: '资金费方向翻转',
  soft_review_due: '滚动组达到72小时重点观察', hard_holding_limit: '滚动组达到7天硬上限',
  settlement_guard_active: '处于结算保护窗口', funding_schedule_unavailable: '结算计划不可用',
};

function reason(value: string): string {
  return reasonLabel[value] ?? value;
}

/** RESEARCH 面板只展示独立模拟账本与扫描漏斗，不提供任何交易操作入口。 */
export function FundingResearchPanel() {
  const [summary, setSummary] = useState<FundingResearchSummary | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [evaluations, setEvaluations] = useState<FundingResearchEvaluation[]>([]);
  const [settlements, setSettlements] = useState<FundingResearchSettlement[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setSummary(await api.fundingResearchSummary()); setError(null); }
    catch (cause) { setError(cause instanceof ApiError ? cause.code : 'funding_research_unavailable'); }
  }, []);

  const refreshDetails = useCallback(async (id: string) => {
    try {
      const result = await api.fundingResearchDetails(id);
      setEvaluations(result.evaluations); setSettlements(result.settlements); setError(null);
    } catch (cause) { setError(cause instanceof ApiError ? cause.code : 'funding_research_details_unavailable'); }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) return;
    void refreshDetails(selectedId);
    const timer = window.setInterval(() => void refreshDetails(selectedId), 5_000);
    return () => window.clearInterval(timer);
  }, [refreshDetails, selectedId]);

  async function toggleDetails(id: string) {
    if (selectedId === id) { setSelectedId(null); setEvaluations([]); setSettlements([]); return; }
    setSelectedId(id); setEvaluations([]); setSettlements([]); await refreshDetails(id);
  }

  return <section className="funding-research-panel terminal-panel" aria-label="探索模拟模式">
    <header>
      <div><p className="eyebrow">Research paper · isolated</p><h2>探索模拟模式 <em>RESEARCH</em></h2></div>
      <span className={summary?.enabled ? 'research-running' : 'paper-stopped'}>
        <i />{summary?.enabled ? '独立模拟运行中' : '探索模拟未开启'}
      </span>
    </header>
    <p className="funding-research-notice">每轮从同步盘口和流动性过滤后的市场选择最优组合，同时开“一次结算验证组”和“滚动持仓组”；每组最多1个、目标每腿 {summary?.targetNotionalUsd ?? '5'} U。毛快照 APR 只表示当前费率外推，可执行保守净收益已扣盘口、四笔手续费、稳定币换算和风险缓冲。不会发送交易所订单。</p>
    {error && <p className="funding-paper-error" role="alert">研究数据读取失败：{error}</p>}

    <div className="funding-research-stats">
      <span><small>24h 扫描组合</small><strong>{summary?.scan24h.observations.toLocaleString() ?? '—'}</strong></span>
      <span><small>达到实盘标准</small><strong>{summary?.scan24h.liveEligible.toLocaleString() ?? '—'}</strong></span>
      <span><small>研究可开仓</small><strong>{summary?.scan24h.researchEligible.toLocaleString() ?? '—'}</strong></span>
      <span><small>完整拒绝</small><strong>{summary?.scan24h.rejected.toLocaleString() ?? '—'}</strong></span>
      <span><small>研究持仓 / 已平</small><strong>{summary ? `${summary.openCount} / ${summary.closedCount}` : '—'}</strong></span>
      <span><small>研究累计 PnL</small><strong>{decimal(summary?.cumulativePnl)} U</strong></span>
    </div>
    {summary && <div className="funding-research-stats">
      {summary.cohorts.map((item) => <span key={item.cohort}><small>{item.cohort === 'ONE_SETTLEMENT' ? '一次结算组' : '滚动持仓组'} 持仓/已平</small><strong>{item.openCount} / {item.closedCount}</strong><em>{decimal(item.cumulativePnl)} U</em></span>)}
    </div>}

    <div className="funding-research-funnel">
      <div><h3>最近24小时拒绝原因</h3>
        <p>{summary?.rejectionReasons.length ? summary.rejectionReasons.map((item) =>
          <span key={item.reason}>{reason(item.reason)} <strong>{item.count}</strong></span>) : <small>暂无完整拒绝记录</small>}</p>
      </div>
      <small>最后扫描：{time(summary?.lastScanAt)} · 实盘和研究资格分别统计</small>
    </div>

    <div className="funding-research-opportunities">
      <h3>最新扫描成本拆解</h3>
      {!summary ? <p className="funding-paper-empty">正在读取扫描漏斗……</p>
        : summary.latestObservations.length === 0 ? <p className="funding-paper-empty">等待第一轮扫描。</p>
          : <div className="research-observation-list">{summary.latestObservations.slice(0, 40).map((item) =>
            <article key={item.id} className={`research-observation status-${item.status.toLowerCase()}`}>
              <div className="research-observation-title">
                <span className="research-status">{item.status === 'LIVE_ELIGIBLE' ? '实盘合格' : item.status === 'RESEARCH_ELIGIBLE' ? 'RESEARCH' : '拒绝'}</span>
                <strong>{item.asset}</strong><span>{item.longVenue} 多 / {item.shortVenue} 空</span>
                <em>{item.executionSupport === 'LIVE_READY' ? '执行器支持' : '暂不支持实盘'} · {reason(item.primaryReason)}</em>
              </div>
              <div className="research-cost-grid">
                <span><small>实际合法数量</small>{item.quantity ?? '—'}</span>
                <span><small>每腿名义</small>{decimal(item.entryLongNotional, 2)} / {decimal(item.entryShortNotional, 2)} U</span>
                <span><small>毛快照 APR</small>{percent(item.rawAnnualized)}</span>
                <span><small>可执行保守净收益年化</small>{percent(item.netAnnualized)}</span>
                <span><small>24h 原始资金费</small>{decimal(item.rawFundingPnl, 6)} U</span>
                <span><small>保守资金费</small>{decimal(item.conservativeFundingPnl, 6)} U</span>
                <span><small>立即往返损益</small>{decimal(item.immediateRoundTripPnl, 6)} U</span>
                <span><small>四笔手续费</small>{decimal(item.tradingFees, 6)} U</span>
                <span><small>压力缓冲</small>{decimal(item.stressBuffer, 6)} U</span>
                <span><small>稳定币风险缓冲</small>{decimal(item.stablecoinRiskBuffer, 6)} U</span>
                <span><small>24h 保守净值</small>{decimal(item.netPnl, 6)} U</span>
                <span><small>盈亏平衡持有</small>{item.breakEvenHours ? `${decimal(item.breakEvenHours, 1)}h` : '不可达'}</span>
                <span><small>入/出滑点</small>{decimal(item.entrySlippageBps, 2)} / {decimal(item.exitSlippageBps, 2)} bp</span>
                <span><small>10bp 四向最小深度</small>{decimal(item.liquidityUsd, 0)} U</span>
                <span><small>报价 / USD 汇率</small>{item.longQuote} {decimal(item.longQuoteToUsd, 5)} / {item.shortQuote} {decimal(item.shortQuoteToUsd, 5)}</span>
                <span><small>优势持续</small>{item.edgeDurationMinutes === undefined ? '—' : `${item.edgeDurationMinutes} 分钟`}</span>
                <span><small>24h 方向翻转</small>{item.directionFlips24h ?? '—'} 次</span>
                <span><small>模拟结算命中率</small>{item.settlementHitRate == null ? '—' : `${percent(item.settlementHitRate)} (${item.settlementSamples})`}</span>
              </div>
            </article>)}</div>}
    </div>

    <div className="funding-research-positions">
      <h3>RESEARCH 模拟持仓</h3>
      {!summary ? <p className="funding-paper-empty">正在加载研究账本……</p>
        : summary.positions.length === 0 ? <p className="funding-paper-empty">等待第一组通过同步、深度、数量和滑点检查的研究机会。</p>
          : summary.positions.map((position) => <article key={position.id} className={`research-position state-${position.state.toLowerCase()}`}>
            <div className="paper-position-head">
              <div><span className="research-status">{position.cohort === 'ONE_SETTLEMENT' ? '一次结算组' : '滚动持仓组'}</span><strong>{position.asset}</strong><span>{position.longVenue} 多 / {position.shortVenue} 空</span></div>
              <span className="paper-position-state">{position.state === 'OPEN' ? '等待真实结算时点' : '研究已平仓'}</span>
            </div>
            <div className="paper-position-metrics">
              <span><small>模拟 PnL</small>{decimal(position.state === 'OPEN' ? position.currentExitPnl : position.totalPnl)} U</span>
              <span><small>资金费</small>{decimal(position.fundingPnl)} U</span>
              <span><small>价差损益</small>{decimal(position.pricePnl)} U</span>
              <span><small>累计手续费</small>{decimal(String(Number(position.entryFees) + Number(position.exitFees)))} U</span>
              <span><small>已结算事件</small>{position.settledEvents}</span>
              <span><small>下一结算</small>{time(position.nextSettlementAt)}</span>
              <span><small>入场毛快照 APR</small>{percent(position.entryRawAnnualized)}</span>
              <span><small>入场保守净收益年化</small>{percent(position.entryNetAnnualized)}</span>
            </div>
            <div className="paper-position-actions">
              <small>{reason(position.lastReason ?? 'research_waiting_first_settlement')} · 开仓 {time(position.openedAt)}</small>
              <button onClick={() => void toggleDetails(position.id)}>{selectedId === position.id ? '收起研究明细' : '查看研究明细'}</button>
            </div>
            {selectedId === position.id && <div className="paper-position-details">
              <div><h4>模拟资金费结算</h4>{settlements.length === 0 ? <p>等待生成结算事件。</p> : settlements.slice(0, 12).map((item) =>
                <p key={item.id}><span>{item.venue} {item.side} · {time(item.fundingTime)}</span>
                  <span>{decimal(item.expectedAmount, 6)} → {decimal(item.amount, 6)} U</span><strong>{item.state}</strong></p>)}</div>
              <div><h4>研究评估时间线</h4>{evaluations.length === 0 ? <p>等待首轮评估。</p> : evaluations.slice(0, 12).map((item) =>
                <p key={item.id}><span>{time(item.observedAt)}</span><span>{item.decision} · {reason(item.reason)}</span>
                  <strong>{decimal(item.currentExitPnl)} U</strong></p>)}</div>
            </div>}
          </article>)}
    </div>
  </section>;
}
