import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type FundingArbitrageTrade, type FundingCandidateExecution,
  type FundingExpectedSettlement, type FundingHoldingEvaluation } from './api.js';

function decimal(value: string | null, digits = 4): string {
  if (value === null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(digits);
}

function rate(value: string | null): string {
  if (value === null || !Number.isFinite(Number(value))) return '—';
  return `${(Number(value) * 100).toFixed(5)}%`;
}

function time(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString('zh-CN', { hour12: false });
}

const decisionLabel: Record<string, string> = {
  HOLD: '继续持有', REVIEW_REQUIRED: '待人工复核', SETTLEMENT_GUARD: '结算保护期', EXIT_PENDING: '退出确认中',
  EXIT: '触发退出', DEGRADED: '监控降级', EMERGENCY_EXIT: '紧急退出', SETTLEMENT_MISSING: '结算未到账',
  SETTLEMENT_ANOMALOUS: '结算金额异常',
  WAITING_FOR_DATA: '等待首轮评估', CLOSED: '已结束', PENDING: '待监控',
};

/** 资金费实盘操作只通过后端状态机，页面不直接构造交易所订单。 */
export function FundingExecutionPanel() {
  const [enabled, setEnabled] = useState(false);
  const [candidates, setCandidates] = useState<FundingCandidateExecution[]>([]);
  const [trades, setTrades] = useState<FundingArbitrageTrade[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);
  const [evaluations, setEvaluations] = useState<FundingHoldingEvaluation[]>([]);
  const [settlements, setSettlements] = useState<FundingExpectedSettlement[]>([]);

  const refresh = useCallback(async () => {
    const [candidateResponse, tradeResponse] = await Promise.all([api.fundingExecutionCandidates(), api.fundingExecutionTrades()]);
    setCandidates(candidateResponse.candidates); setTrades(tradeResponse.trades); setEnabled(tradeResponse.enabled);
  }, []);
  useEffect(() => { void refresh().catch(() => undefined); const timer = window.setInterval(() => void refresh().catch(() => undefined), 5_000); return () => window.clearInterval(timer); }, [refresh]);
  useEffect(() => {
    if (!selectedTradeId) return undefined;
    const load = async () => {
      const response = await api.fundingTradeMonitoring(selectedTradeId);
      setEvaluations(response.evaluations); setSettlements(response.expectedSettlements);
    };
    const timer = window.setInterval(() => void load().catch(() => undefined), 5_000);
    return () => window.clearInterval(timer);
  }, [selectedTradeId]);

  async function act(operation: () => Promise<unknown>, success: string) {
    setBusy(true); setMessage('');
    try { await operation(); setMessage(success); await refresh(); }
    catch (error) { setMessage(error instanceof ApiError ? error.code : 'operation_failed'); }
    finally { setBusy(false); }
  }

  async function showMonitoring(tradeId: string) {
    if (selectedTradeId === tradeId) { setSelectedTradeId(null); return; }
    setBusy(true); setMessage('');
    try {
      const response = await api.fundingTradeMonitoring(tradeId);
      setSelectedTradeId(tradeId); setEvaluations(response.evaluations); setSettlements(response.expectedSettlements);
    } catch (error) { setMessage(error instanceof ApiError ? error.code : 'monitoring_load_failed'); }
    finally { setBusy(false); }
  }

  const confirmed = candidates.find((candidate) => candidate.state === 'CONFIRMED');

  return <section className="funding-execution-panel terminal-panel" aria-label="资金费实盘执行">
    <header><div><p className="eyebrow">Funding execution</p><h2>资金费套利状态机</h2></div>
      <span className={enabled ? 'funding-live-armed' : 'funding-live-locked'}>{enabled ? '后端已启用' : '后端安全锁定'}</span></header>
    <p className="funding-execution-warning">候选由后端使用 Gate 已认证资金费、手续费和同步订单簿自动计算。任何状态不确定都会触发减仓、Kill Switch 或人工接管。</p>
    <div className="funding-candidate-strip">
      <span>确认候选 <strong>{candidates.filter((item) => item.state === 'CONFIRMED').length}</strong></span>
      <span>开放组合 <strong>{trades.filter((item) => item.state === 'OPEN').length}</strong></span>
      <span>监控异常 <strong>{trades.filter((item) => ['DEGRADED', 'EMERGENCY_EXIT', 'SETTLEMENT_MISSING'].includes(item.monitorState)).length}</strong></span>
      <span>实盘开关 <strong>{enabled ? 'ON' : 'OFF'}</strong></span>
    </div>
    {confirmed && <article className="funding-confirmed-candidate">
      <div><strong>{confirmed.asset}</strong><small>{confirmed.longVenue} 多 / {confirmed.shortVenue} 空</small></div>
      <div><small>当前费率快照</small><span>{rate(confirmed.longRate)} / {rate(confirmed.shortRate)}</span></div>
      <div><small>保守情景年化</small><span>{rate(confirmed.netAnnualized)}</span></div>
      <div><small>连续确认</small><span>{confirmed.confirmationCount} 次</span></div>
    </article>}
    <div className="funding-execution-actions">
      <button className="danger" disabled={busy || !enabled || !confirmed} onClick={() => confirmed && void act(() => api.startFundingArbitrage({
        idempotencyKey: `ui:${crypto.randomUUID()}`, candidateId: confirmed.id, asset: confirmed.asset,
        longVenue: confirmed.longVenue, shortVenue: confirmed.shortVenue, quantity: confirmed.quantity, timeInForce: 'FOK',
      }), '入场状态机已执行')}>确认候选并实盘入场</button>
      {message && <output>{message}</output>}
    </div>
    <div className="funding-execution-ledger">
      <h3>最近执行</h3>
      {trades.length === 0 ? <p>暂无资金费实盘记录。</p> : trades.slice(0, 8).map((trade) => <article key={trade.id}>
        <div className="funding-trade-summary">
          <span><strong>{trade.asset}</strong> {trade.longVenue} 多 / {trade.shortVenue} 空</span>
          <span>{trade.state} · {trade.openQuantity}</span>
          <span className={`funding-monitor-state state-${trade.monitorState.toLowerCase()}`}>
            {decisionLabel[trade.monitorState] ?? trade.monitorState}</span>
        </div>
        <div className="funding-trade-metrics">
          <span><small>继续持有价值</small>{decimal(trade.holdValue)} USDT</span>
          <span><small>立即平仓 PnL</small>{decimal(trade.currentExitPnl)} USDT</span>
          <span><small>实际资金费</small>{decimal(trade.cumulativeActualFunding)} USDT</span>
          <span><small>当前基差</small>{decimal(trade.currentBasisBps, 2)} bps</span>
          <span><small>下一结算</small>{time(trade.nextSettlementAt)}</span>
          <span><small>不盈利确认</small>{trade.unprofitableCount} 次</span>
        </div>
        <p className="funding-monitor-reason">{trade.lastMonitorReason ?? '等待监控器生成第一轮判断'} · 最后评估 {time(trade.lastMonitorAt)}</p>
        <div className="funding-trade-actions">
          <button disabled={busy} onClick={() => void showMonitoring(trade.id)}>{selectedTradeId === trade.id ? '收起详情' : '查看评估'}</button>
          {trade.state === 'OPEN' && <button disabled={busy} onClick={() => void act(() => api.closeFundingArbitrage(trade.id), 'Reduce-only 平仓已执行')}>平仓</button>}
        </div>
        {selectedTradeId === trade.id && <div className="funding-monitor-detail">
          <div><h4>结算对账</h4>{settlements.length === 0 ? <p>尚未生成预期结算事件。</p> : settlements.slice(0, 8).map((item) =>
            <p key={item.id}><span>{item.venue} · {time(item.fundingTime)}</span><span>{decimal(item.expectedAmount)} → {decimal(item.actualAmount)} USDT</span><strong>{item.state}</strong></p>)}</div>
          <div><h4>滚动判断时间线</h4>{evaluations.length === 0 ? <p>尚无评估记录。</p> : evaluations.slice(0, 8).map((item) =>
            <p key={item.id}><span>{time(item.observedAt)}</span><span>{decisionLabel[item.decision] ?? item.decision} · {item.reason}</span><strong>{decimal(item.holdValue)} U</strong></p>)}</div>
        </div>}
      </article>)}
    </div>
  </section>;
}
