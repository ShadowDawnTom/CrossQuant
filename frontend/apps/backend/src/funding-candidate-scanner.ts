import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { GateCredentials } from './credential-vault.js';
import type { GateCrossExSymbol, GateFeeRate, GateFundingInfo, TradingCrossExGateway } from './crossex-client.js';
import type { ExecutionMarketReader, ExecutionVenue } from './execution-market-hub.js';
import { FundingArbitrageError, type FundingArbitrageEngine } from './funding-arbitrage-engine.js';

const SUPPORTED_VENUES = new Set<ExecutionVenue>(['GATE', 'BINANCE', 'OKX', 'BYBIT']);
const SYMBOL = /^(GATE|BINANCE|OKX|BYBIT)_FUTURE_([A-Z0-9]+)_USDT$/;

export interface FundingCandidateScannerOptions {
  assets: string[];
  strictAssets?: string[];
  targetNotionalUsd: string;
  horizonHours: number;
  fundingRetentionFactor: string;
  stressSlippageBps: string;
  adverseExitBasisBps: string;
  minNetAnnualized?: string;
  researchAssets?: string[];
  researchTargetNotionalUsd?: string;
  researchMaxSlippageBps?: string;
  onFundingData?: (funding: readonly GateFundingInfo[], fees: readonly GateFeeRate[],
    observations: readonly FundingScanObservation[]) => void | Promise<void>;
  now?: () => number;
}

export type FundingScanStatus = 'LIVE_ELIGIBLE' | 'RESEARCH_ELIGIBLE' | 'REJECTED';

export interface FundingScanObservation {
  id: string;
  scanId: string;
  observedAt: string;
  asset: string;
  longVenue: ExecutionVenue;
  shortVenue: ExecutionVenue;
  quantity: string | null;
  status: FundingScanStatus;
  strictEligible: boolean;
  researchEligible: boolean;
  primaryReason: string;
  reasons: string[];
  marketQuality: string | null;
  longRate: string;
  shortRate: string;
  longEvents: number;
  shortEvents: number;
  entryLongPrice: string | null;
  entryShortPrice: string | null;
  exitLongPrice: string | null;
  exitShortPrice: string | null;
  entryLongNotional: string | null;
  entryShortNotional: string | null;
  rawFundingPnl: string | null;
  conservativeFundingPnl: string | null;
  immediateRoundTripPnl: string | null;
  entryFees: string | null;
  exitFees: string | null;
  tradingFees: string | null;
  stressBuffer: string | null;
  netPnl: string | null;
  rawAnnualized: string | null;
  netAnnualized: string | null;
  breakEvenHours: string | null;
  entrySlippageBps: string | null;
  exitSlippageBps: string | null;
  basisBps: string | null;
}

function eventCount(item: GateFundingInfo, now: number, horizonMs: number): number {
  const intervalMs = Number(item.funding_interval) * 1_000;
  let next = Number(item.funding_time);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(next) || next <= 0) return 0;
  if (next <= now) next += (Math.floor((now - next) / intervalMs) + 1) * intervalMs;
  const end = now + horizonMs;
  return next > end ? 0 : Math.floor((end - next) / intervalMs) + 1;
}

function commonStep(first: string, second: string): Decimal {
  const a = new Decimal(first);
  const b = new Decimal(second);
  if (!a.gt(0) || !b.gt(0)) throw new Error('invalid_lot_size');
  const scale = Math.max(a.decimalPlaces(), b.decimalPlaces());
  const multiplier = new Decimal(10).pow(scale);
  const left = BigInt(a.mul(multiplier).toFixed(0));
  const right = BigInt(b.mul(multiplier).toFixed(0));
  const gcd = (x: bigint, y: bigint): bigint => { let m = x; let n = y; while (n !== 0n) [m, n] = [n, m % n]; return m; };
  return new Decimal((left / gcd(left, right) * right).toString()).div(multiplier);
}

function feeFor(fees: GateFeeRate[], venue: ExecutionVenue, symbol: string): Decimal {
  const row = fees.find((item) => item.exchange_type === venue);
  if (!row) throw new Error(`missing_fee:${venue}`);
  const special = row.special_fee_list?.find((item) => item.symbol === symbol)?.taker_fee_rate;
  return new Decimal(special ?? row.future_taker_fee);
}

interface ExecutableFill { average: Decimal; notional: Decimal; top: Decimal; slippageBps: Decimal }

function executableFill(levels: ReadonlyArray<readonly [string, string]>, quantity: Decimal, side: 'BUY' | 'SELL'): ExecutableFill | null {
  let remaining = quantity;
  let notional = new Decimal(0);
  const top = new Decimal(levels[0]?.[0] ?? '0');
  if (!top.gt(0)) return null;
  for (const [rawPrice, rawSize] of levels) {
    const price = new Decimal(rawPrice);
    const size = new Decimal(rawSize);
    if (!price.gt(0) || !size.gt(0)) continue;
    const filled = Decimal.min(remaining, size);
    notional = notional.plus(filled.mul(price));
    remaining = remaining.minus(filled);
    if (remaining.lte(0)) {
      const average = notional.div(quantity);
      const slippageBps = side === 'BUY'
        ? average.minus(top).div(top).mul(10_000)
        : top.minus(average).div(top).mul(10_000);
      return { average, notional, top, slippageBps: Decimal.max(0, slippageBps) };
    }
  }
  return null;
}

/**
 * 资金费候选只从 Gate 已认证接口生成。扫描器按实际结算事件做“当前费率不变”情景，
 * 再扣除多档盘口往返损益、四次 taker 手续费和额外压力缓冲；它永远不直接下单。
 */
export class FundingCandidateScanner {
  private readonly now: () => number;
  private referenceCache: { rules: GateCrossExSymbol[]; fees: GateFeeRate[]; expiresAt: number } | null = null;
  private activeScan: Promise<number> | null = null;

  constructor(
    private readonly gateway: TradingCrossExGateway,
    private readonly credentials: () => Promise<GateCredentials | null>,
    private readonly market: ExecutionMarketReader,
    private readonly engine: FundingArbitrageEngine,
    private readonly options: FundingCandidateScannerOptions,
  ) { this.now = options.now ?? Date.now; }

  private async referenceData(credentials: GateCredentials): Promise<{ rules: GateCrossExSymbol[]; fees: GateFeeRate[] }> {
    if (this.referenceCache && this.referenceCache.expiresAt >= this.now()) return this.referenceCache;
    const [rules, fees] = await Promise.all([this.gateway.querySymbols(), this.gateway.queryFeeRates(credentials)]);
    this.referenceCache = { rules, fees, expiresAt: this.now() + 10 * 60_000 };
    return this.referenceCache;
  }

  scan(): Promise<number> {
    // 定时器不能堆积认证请求；上一轮未结束时复用同一个 Promise，让网关的限频冷却真正生效。
    if (this.activeScan) return this.activeScan;
    this.activeScan = this.runScan().finally(() => { this.activeScan = null; });
    return this.activeScan;
  }

  private async runScan(): Promise<number> {
    const credentials = await this.credentials();
    if (!credentials) return 0;
    const assets = [...new Set(this.options.assets.map((asset) => asset.toUpperCase()))];
    const strictAssets = new Set((this.options.strictAssets ?? assets).map((asset) => asset.toUpperCase()));
    const researchAssets = new Set((this.options.researchAssets ?? []).map((asset) => asset.toUpperCase()));
    const minNetAnnualized = new Decimal(this.options.minNetAnnualized ?? '0');
    const researchMaxSlippageBps = new Decimal(this.options.researchMaxSlippageBps ?? '10');
    const scanId = randomUUID();
    const observedAt = new Date(this.now()).toISOString();
    const observations: FundingScanObservation[] = [];
    const requestedSymbols = assets.flatMap((asset) => [...SUPPORTED_VENUES].map((venue) => `${venue}_FUTURE_${asset}_USDT`));
    const [funding, reference] = await Promise.all([
      this.gateway.queryFundingInfo!(credentials, requestedSymbols), this.referenceData(credentials),
    ]);
    const { rules, fees } = reference;
    const ruleMap = new Map(rules.map((rule) => [rule.symbol, rule]));
    const horizonMs = this.options.horizonHours * 60 * 60_000;
    let recorded = 0;
    for (const asset of assets) {
      const rows = funding.filter((item) => SYMBOL.exec(item.symbol)?.[2] === asset);
      for (let left = 0; left < rows.length; left += 1) for (let right = left + 1; right < rows.length; right += 1) {
        const first = rows[left]!;
        const second = rows[right]!;
        const firstMatch = SYMBOL.exec(first.symbol);
        const secondMatch = SYMBOL.exec(second.symbol);
        if (!firstMatch || !secondMatch) continue;
        const firstVenue = firstMatch[1] as ExecutionVenue;
        const secondVenue = secondMatch[1] as ExecutionVenue;
        const firstEvents = eventCount(first, this.now(), horizonMs);
        const secondEvents = eventCount(second, this.now(), horizonMs);
        if (firstEvents === 0 && secondEvents === 0) continue;
        const firstTotal = new Decimal(first.funding_rate).mul(firstEvents);
        const secondTotal = new Decimal(second.funding_rate).mul(secondEvents);
        const [long, short, longVenue, shortVenue, longEvents, shortEvents] = firstTotal.lte(secondTotal)
          ? [first, second, firstVenue, secondVenue, firstEvents, secondEvents] as const
          : [second, first, secondVenue, firstVenue, secondEvents, firstEvents] as const;
        const baseObservation = {
          id: randomUUID(), scanId, observedAt, asset, longVenue, shortVenue,
          longRate: long.funding_rate, shortRate: short.funding_rate, longEvents, shortEvents,
        };
        const reject = (primaryReason: string, marketQuality: string | null = null,
          reasons: string[] = [primaryReason]): void => {
          observations.push({ ...baseObservation, quantity: null, status: 'REJECTED', strictEligible: false,
            researchEligible: false, primaryReason, reasons: [...new Set(reasons)], marketQuality,
            entryLongPrice: null, entryShortPrice: null, exitLongPrice: null, exitShortPrice: null,
            entryLongNotional: null, entryShortNotional: null, rawFundingPnl: null, conservativeFundingPnl: null,
            immediateRoundTripPnl: null, entryFees: null, exitFees: null, tradingFees: null, stressBuffer: null,
            netPnl: null, rawAnnualized: null, netAnnualized: null, breakEvenHours: null,
            entrySlippageBps: null, exitSlippageBps: null, basisBps: null });
        };
        const longRule = ruleMap.get(long.symbol);
        const shortRule = ruleMap.get(short.symbol);
        if (!longRule || !shortRule) { reject('instrument_rule_missing'); continue; }
        if (longRule.state !== 'live' || shortRule.state !== 'live') { reject('instrument_not_live'); continue; }
        let pair;
        try { pair = this.market.pair(asset, longVenue, shortVenue, this.now()); }
        catch { reject('market_pair_unavailable'); continue; }
        if (pair.quality !== 'LIVE_SYNCHRONIZED') {
          reject('market_not_synchronized', pair.quality, ['market_not_synchronized', ...pair.reasons]);
          continue;
        }
        const longPrice = new Decimal(pair.longBook.asks[0]?.[0] ?? '0');
        const shortPrice = new Decimal(pair.shortBook.bids[0]?.[0] ?? '0');
        if (!longPrice.gt(0) || !shortPrice.gt(0)) { reject('top_of_book_missing', pair.quality); continue; }
        let step;
        try { step = commonStep(longRule.lot_size, shortRule.lot_size); }
        catch { reject('invalid_quantity_rule', pair.quality); continue; }
        const configuredTarget = Decimal.max(
          strictAssets.has(asset) ? this.options.targetNotionalUsd : '0',
          researchAssets.has(asset) ? this.options.researchTargetNotionalUsd ?? this.options.targetNotionalUsd : '0',
        );
        const minimumNotional = Decimal.max(
          configuredTarget,
          longRule.min_notional ?? '0',
          shortRule.min_notional ?? '0',
        );
        const minimumQuantity = Decimal.max(longRule.min_size, shortRule.min_size, minimumNotional.div(Decimal.min(longPrice, shortPrice)));
        const quantity = minimumQuantity.div(step).ceil().mul(step);
        // 同一数量按盘口逐档吃单；深度不足必须 fail-closed，不能用不存在的顶层价格放行。
        const longEntry = executableFill(pair.longBook.asks, quantity, 'BUY');
        const shortEntry = executableFill(pair.shortBook.bids, quantity, 'SELL');
        const longExit = executableFill(pair.longBook.bids, quantity, 'SELL');
        const shortExit = executableFill(pair.shortBook.asks, quantity, 'BUY');
        if (!longEntry || !shortEntry || !longExit || !shortExit) { reject('insufficient_executable_depth', pair.quality); continue; }
        const capital = longEntry.notional.plus(shortEntry.notional).div(2);
        if (!capital.gt(0)) { reject('invalid_executable_notional', pair.quality); continue; }
        let longFee;
        let shortFee;
        try { longFee = feeFor(fees, longVenue, long.symbol); shortFee = feeFor(fees, shortVenue, short.symbol); }
        catch { reject('fee_rate_missing', pair.quality); continue; }
        const snapshotFundingPnl = shortEntry.notional.mul(short.funding_rate).mul(shortEvents)
          .minus(longEntry.notional.mul(long.funding_rate).mul(longEvents));
        // q[(P_long_exit_bid-P_long_entry_ask)+(P_short_entry_bid-P_short_exit_ask)]。
        // 这里用当前盘口模拟立即往返，只估算此刻交易摩擦，不预测未来退出时的基差。
        const immediateRoundTripPnl = longExit.notional.minus(longEntry.notional)
          .plus(shortEntry.notional).minus(shortExit.notional);
        const entryFees = longEntry.notional.mul(longFee).plus(shortEntry.notional.mul(shortFee));
        const exitFees = longExit.notional.mul(longFee).plus(shortExit.notional.mul(shortFee));
        const tradingFees = entryFees.plus(exitFees);
        const retention = new Decimal(this.options.fundingRetentionFactor);
        const conservativeFundingPnl = snapshotFundingPnl.gt(0) ? snapshotFundingPnl.mul(retention) : snapshotFundingPnl;
        const stressBuffer = capital.mul(new Decimal(this.options.stressSlippageBps)
          .plus(this.options.adverseExitBasisBps)).div(10_000);
        const netPnl = conservativeFundingPnl.plus(immediateRoundTripPnl).minus(tradingFees).minus(stressBuffer);
        const rawAnnualized = snapshotFundingPnl.div(capital).mul(8760).div(this.options.horizonHours);
        const netAnnualized = netPnl.div(capital).mul(8760).div(this.options.horizonHours);
        const entrySlippageBps = longEntry.slippageBps.plus(shortEntry.slippageBps);
        const exitSlippageBps = longExit.slippageBps.plus(shortExit.slippageBps);
        const basisBps = longEntry.average.minus(shortEntry.average).abs()
          .div(longEntry.average.plus(shortEntry.average).div(2)).mul(10_000);
        const friction = tradingFees.plus(stressBuffer).minus(immediateRoundTripPnl);
        const breakEvenHours = conservativeFundingPnl.gt(0)
          ? Decimal.max(0, friction).mul(this.options.horizonHours).div(conservativeFundingPnl)
          : null;
        const researchEligible = researchAssets.has(asset) && snapshotFundingPnl.gt(0)
          && entrySlippageBps.lte(researchMaxSlippageBps) && exitSlippageBps.lte(researchMaxSlippageBps);
        let strictEligible = false;
        let strictReason = strictAssets.has(asset) ? 'funding_net_return_below_threshold' : 'strict_asset_not_enabled';
        if (strictAssets.has(asset) && netAnnualized.gte(minNetAnnualized)) {
          try {
            await this.engine.observeAuthoritativeCandidate({ asset, longVenue, shortVenue, quantity: quantity.toString(),
              longRate: long.funding_rate, shortRate: short.funding_rate, netAnnualized: netAnnualized.toString() });
            strictEligible = true;
            strictReason = 'live_threshold_passed';
            recorded += 1;
          } catch (error) {
            strictReason = error instanceof FundingArbitrageError ? error.code : 'strict_candidate_rejected';
          }
        }
        const researchReason = !researchAssets.has(asset) ? 'research_asset_not_enabled'
          : !snapshotFundingPnl.gt(0) ? 'raw_funding_not_positive'
            : entrySlippageBps.gt(researchMaxSlippageBps) ? 'research_entry_slippage_exceeded'
              : exitSlippageBps.gt(researchMaxSlippageBps) ? 'research_exit_slippage_exceeded'
                : 'research_liquidity_passed';
        const status: FundingScanStatus = strictEligible ? 'LIVE_ELIGIBLE'
          : researchEligible ? 'RESEARCH_ELIGIBLE' : 'REJECTED';
        const reasons = [...new Set([strictReason, researchReason])];
        observations.push({ ...baseObservation, quantity: quantity.toString(), status, strictEligible, researchEligible,
          primaryReason: strictEligible ? 'live_threshold_passed' : researchEligible ? strictReason : researchReason,
          reasons, marketQuality: pair.quality, entryLongPrice: longEntry.average.toString(),
          entryShortPrice: shortEntry.average.toString(), exitLongPrice: longExit.average.toString(),
          exitShortPrice: shortExit.average.toString(), entryLongNotional: longEntry.notional.toString(),
          entryShortNotional: shortEntry.notional.toString(), rawFundingPnl: snapshotFundingPnl.toString(),
          conservativeFundingPnl: conservativeFundingPnl.toString(), immediateRoundTripPnl: immediateRoundTripPnl.toString(),
          entryFees: entryFees.toString(), exitFees: exitFees.toString(), tradingFees: tradingFees.toString(),
          stressBuffer: stressBuffer.toString(), netPnl: netPnl.toString(), rawAnnualized: rawAnnualized.toString(),
          netAnnualized: netAnnualized.toString(), breakEvenHours: breakEvenHours?.toString() ?? null,
          entrySlippageBps: entrySlippageBps.toString(), exitSlippageBps: exitSlippageBps.toString(),
          basisBps: basisBps.toString() });
      }
    }
    // 持仓监控复用本轮认证数据，避免再打一遍 funding_info 和 fee 接口触发限频。
    await this.options.onFundingData?.(funding, fees, observations);
    return recorded;
  }
}

export function fundingRule(rule: GateCrossExSymbol) {
  return { symbol: rule.symbol, state: rule.state, minSize: rule.min_size, minNotional: rule.min_notional,
    lotSize: rule.lot_size, tickSize: rule.tick_size, maxMarketSize: rule.max_market_size, maxLimitSize: rule.max_limit_size };
}
