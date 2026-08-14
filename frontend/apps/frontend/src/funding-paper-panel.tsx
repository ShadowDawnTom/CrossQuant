import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type FundingPaperEvaluation, type FundingPaperSettlement,
  type FundingPaperSummary } from './api.js';

function decimal(value: string | null | undefined, digits = 4): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '—';
}

function percent(value: string | null | undefined, digits = 2): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(digits)}%` : '—';
}

function time(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString('zh-CN', { hour12: false }) : '—';
}

const decisionLabel: Record<string, string> = {
  HOLD: '继续持有', REVIEW_REQUIRED: '重点复核', SETTLEMENT_GUARD: '结算保护',
  EXIT_PENDING: '等待退出确认', EXIT: '已退出', DEGRADED: '数据降级', PENDING: '等待首轮评估',
};

/** 模拟盘只读取后端纸面成交记录，所有金额都明确标记为模拟值。 */
export function FundingPaperPanel() {
  const [summary, setSummary] = useState<FundingPaperSummary | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [evaluations, setEvaluations] = useState<FundingPaperEvaluation[]>([]);
  const [settlements, setSettlements] = useState<FundingPaperSettlement[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setSummary(await api.fundingPaperSummary()); setError(null); }
    catch (reason) { setError(reason instanceof ApiError ? reason.code : 'paper_summary_unavailable'); }
  }, []);

  const refreshDetails = useCallback(async (id: string) => {
    try {
      const result = await api.fundingPaperDetails(id);
      setEvaluations(result.evaluations); setSettlements(result.settlements); setError(null);
    } catch (reason) { setError(reason instanceof ApiError ? reason.code : 'paper_details_unavailable'); }
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

  return <section className="funding-paper-panel terminal-panel" aria-label="资金费模拟盘">
    <header>
      <div><p className="eyebrow">Paper trading</p><h2>资金费模拟盘</h2></div>
      <span className={summary?.enabled ? 'paper-running' : 'paper-stopped'}>
        <i />{summary?.enabled ? '自动运行中' : '模拟盘未开启'}
      </span>
    </header>
    <p className="funding-paper-notice">使用真实同步盘口做纸面双腿成交；不会发送交易所订单，不占用保证金。PnL 已扣模拟开平仓手续费与盘口滑点。</p>
    {error && <p className="funding-paper-error" role="alert">数据读取失败：{error}</p>}
    <div className="funding-paper-stats">
      <span><small>模拟持仓</small><strong>{summary?.openCount ?? '—'}</strong></span>
      <span><small>已平仓</small><strong>{summary?.closedCount ?? '—'}</strong></span>
      <span><small>累计模拟 PnL</small><strong>{decimal(summary?.cumulativePnl)} U</strong></span>
      <span><small>累计模拟资金费</small><strong>{decimal(summary?.cumulativeFunding)} U</strong></span>
      <span><small>累计模拟手续费</small><strong>{decimal(summary?.cumulativeFees)} U</strong></span>
      <span><small>模拟胜率</small><strong>{percent(summary?.winRate)}</strong></span>
    </div>
    <div className="funding-paper-data-health">
      <span>资金费快照 <strong>{summary?.fundingSnapshotCount.toLocaleString() ?? '—'}</strong><small>{time(summary?.latestFundingSnapshotAt)}</small></span>
      <span>同步盘口样本 <strong>{summary?.executionSampleCount.toLocaleString() ?? '—'}</strong><small>{time(summary?.latestExecutionSampleAt)}</small></span>
      <span>开仓规则 <strong>连续确认 + LIVE_SYNCHRONIZED</strong><small>不为了凑数据强行开仓</small></span>
    </div>
    <div className="funding-paper-positions">
      <h3>模拟持仓与最近平仓</h3>
      {!summary ? <p className="funding-paper-empty">正在加载模拟盘……</p>
        : summary.positions.length === 0 ? <p className="funding-paper-empty">正在等待第一个满足保守净收益和同步盘口要求的候选。</p>
          : summary.positions.map((position) => <article key={position.id} className={`paper-position state-${position.state.toLowerCase()}`}>
            <div className="paper-position-head">
              <div><strong>{position.asset}</strong><span>{position.longVenue} 多 / {position.shortVenue} 空</span></div>
              <span className="paper-position-state">{position.state === 'OPEN' ? '模拟持仓中' : '模拟已平仓'}</span>
            </div>
            <div className="paper-position-metrics">
              <span><small>数量</small>{position.quantity}</span>
              <span><small>模拟 PnL</small>{decimal(position.state === 'OPEN' ? position.currentExitPnl : position.totalPnl)} U</span>
              <span><small>资金费</small>{decimal(position.fundingPnl)} U</span>
              <span><small>价差损益</small>{decimal(position.pricePnl)} U</span>
              <span><small>开仓手续费</small>{decimal(position.entryFees)} U</span>
              <span><small>继续持有价值</small>{decimal(position.holdValue)} U</span>
              <span><small>当前基差</small>{decimal(position.currentBasisBps, 2)} bps</span>
              <span><small>下一结算</small>{time(position.nextSettlementAt)}</span>
            </div>
            <div className="paper-position-prices">
              <span>开仓：{position.longVenue} {decimal(position.entryLongPrice, 6)} / {position.shortVenue} {decimal(position.entryShortPrice, 6)}</span>
              <span>当前费率：{percent(position.longRate, 4)} / {percent(position.shortRate, 4)}</span>
              <span>{decisionLabel[position.monitorState] ?? position.monitorState} · {position.lastReason ?? '等待首轮评估'}</span>
            </div>
            <div className="paper-position-actions">
              <small>开仓 {time(position.openedAt)} · 最后评估 {time(position.lastEvaluatedAt)}</small>
              <button onClick={() => void toggleDetails(position.id)}>{selectedId === position.id ? '收起明细' : '查看明细'}</button>
            </div>
            {selectedId === position.id && <div className="paper-position-details">
              <div><h4>模拟资金费结算</h4>
                {settlements.length === 0 ? <p>尚未生成结算事件。</p> : settlements.slice(0, 12).map((item) =>
                  <p key={item.id}><span>{item.venue} · {time(item.fundingTime)}</span>
                    <span>{decimal(item.expectedAmount)} → {decimal(item.amount)} U</span><strong>{item.state}</strong></p>)}
              </div>
              <div><h4>滚动评估时间线</h4>
                {evaluations.length === 0 ? <p>等待首轮模拟评估。</p> : evaluations.slice(0, 12).map((item) =>
                  <p key={item.id}><span>{time(item.observedAt)}</span>
                    <span>{decisionLabel[item.decision] ?? item.decision} · {item.reason}</span>
                    <strong>{decimal(item.currentExitPnl)} U</strong></p>)}
              </div>
            </div>}
          </article>)}
    </div>
  </section>;
}
