import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type FundingArbitrageTrade, type FundingCandidateExecution } from './api.js';

/** 资金费实盘操作只通过后端状态机，页面不直接构造交易所订单。 */
export function FundingExecutionPanel() {
  const [enabled, setEnabled] = useState(false);
  const [candidates, setCandidates] = useState<FundingCandidateExecution[]>([]);
  const [trades, setTrades] = useState<FundingArbitrageTrade[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [candidateResponse, tradeResponse] = await Promise.all([api.fundingExecutionCandidates(), api.fundingExecutionTrades()]);
    setCandidates(candidateResponse.candidates); setTrades(tradeResponse.trades); setEnabled(tradeResponse.enabled);
  }, []);
  useEffect(() => { void refresh().catch(() => undefined); const timer = window.setInterval(() => void refresh().catch(() => undefined), 5_000); return () => window.clearInterval(timer); }, [refresh]);

  async function act(operation: () => Promise<unknown>, success: string) {
    setBusy(true); setMessage('');
    try { await operation(); setMessage(success); await refresh(); }
    catch (error) { setMessage(error instanceof ApiError ? error.code : 'operation_failed'); }
    finally { setBusy(false); }
  }

  const confirmed = candidates.find((candidate) => candidate.state === 'CONFIRMED');

  return <section className="funding-execution-panel terminal-panel" aria-label="资金费实盘执行">
    <header><div><p className="eyebrow">Funding execution</p><h2>资金费套利状态机</h2></div>
      <span className={enabled ? 'funding-live-armed' : 'funding-live-locked'}>{enabled ? '后端已启用' : '后端安全锁定'}</span></header>
    <p className="funding-execution-warning">候选由后端使用 Gate 已认证资金费、手续费和同步订单簿自动计算。任何状态不确定都会触发减仓、Kill Switch 或人工接管。</p>
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
        <span><strong>{trade.asset}</strong> {trade.longVenue} 多 / {trade.shortVenue} 空</span>
        <span>{trade.state} · {trade.openQuantity}</span>
        {trade.state === 'OPEN' && <button disabled={busy} onClick={() => void act(() => api.closeFundingArbitrage(trade.id), 'Reduce-only 平仓已执行')}>平仓</button>}
      </article>)}
    </div>
  </section>;
}
