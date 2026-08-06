import { Decimal } from 'decimal.js';
import type { PortfolioSnapshot, ReconciliationIssue, ReconciliationReport } from '@gate-crossex/shared-types';

/**
 * Money math must not inherit decimal.js's global mutable defaults (precision 20,
 * ROUND_HALF_UP): a 20-significant-digit quotient can round UP across a step boundary, and any
 * module calling Decimal.set() would silently change money semantics for everyone sharing the
 * singleton. This clone pins high precision with round-down, so a result at the precision limit
 * errs toward a smaller size or notional, never a larger one.
 */
const FinanceDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_DOWN });

export class DomainDecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainDecimalError';
  }
}

function financeDecimal(label: string, value: string): Decimal {
  let parsed: Decimal;
  try {
    parsed = new FinanceDecimal(value);
  } catch {
    throw new DomainDecimalError(`${label} is not a decimal string`);
  }
  if (!parsed.isFinite()) throw new DomainDecimalError(`${label} must be a finite decimal`);
  return parsed;
}

export function decimalNotional(price: string, quantity: string, multiplier = '1'): string {
  return financeDecimal('price', price)
    .mul(financeDecimal('quantity', quantity))
    .mul(financeDecimal('multiplier', multiplier))
    .toFixed();
}

export function roundDownToStep(value: string, step: string): string {
  const v = financeDecimal('value', value);
  const s = financeDecimal('step', step);
  if (!s.gt(0)) throw new DomainDecimalError('step must be greater than zero');
  if (v.isNegative()) throw new DomainDecimalError('value must not be negative');
  return v.divToInt(s).mul(s).toFixed();
}

function changedFields<T extends object>(previous: T, current: T, fields: Array<keyof T>): string[] {
  return fields.filter((field) => previous[field] !== current[field]).map(String).sort();
}

function issue(
  code: ReconciliationIssue['code'],
  severity: ReconciliationIssue['severity'],
  entityType: ReconciliationIssue['entityType'],
  entityId: string | null,
  summary: string,
  fields: string[] = [],
): ReconciliationIssue {
  return { code, severity, entityType, entityId, summary, changedFields: fields };
}

export function reconcilePortfolioSnapshots(
  reportId: string,
  createdAt: string,
  previous: PortfolioSnapshot | null,
  current: PortfolioSnapshot,
): ReconciliationReport {
  if (!previous) {
    return {
      id: reportId, createdAt, status: 'baseline', previousFetchedAt: null,
      currentFetchedAt: current.fetchedAt,
      issues: [issue('baseline_created', 'info', 'system', null, 'Initial validated remote account baseline recorded.')],
    };
  }

  const issues: ReconciliationIssue[] = [];
  const accountFields = changedFields(previous.account, current.account, ['accountMode', 'positionMode', 'exchangeType']);
  if (accountFields.length > 0) {
    issues.push(issue('account_configuration_changed', 'warning', 'account', null, 'Remote account configuration changed.', accountFields));
  }

  const previousFutures = new Map(previous.futuresPositions.map((position) => [position.positionId, position]));
  const currentFutures = new Map(current.futuresPositions.map((position) => [position.positionId, position]));
  for (const [id, position] of currentFutures) {
    const before = previousFutures.get(id);
    if (!before) issues.push(issue('unknown_futures_position_detected', 'warning', 'futures_position', id, `Unrecognized remote futures position detected for ${position.symbol}.`));
    else {
      const fields = changedFields(before, position, ['symbol', 'positionSide', 'quantity', 'entryPrice', 'leverage']);
      if (fields.length > 0) issues.push(issue('futures_position_changed', 'warning', 'futures_position', id, `Remote futures position changed for ${position.symbol}.`, fields));
    }
  }
  for (const [id, position] of previousFutures) {
    if (!currentFutures.has(id)) issues.push(issue('futures_position_disappeared', 'warning', 'futures_position', id, `Previously observed futures position disappeared for ${position.symbol}.`));
  }

  const previousMargin = new Map(previous.marginPositions.map((position) => [position.positionId, position]));
  const currentMargin = new Map(current.marginPositions.map((position) => [position.positionId, position]));
  for (const [id, position] of currentMargin) {
    const before = previousMargin.get(id);
    if (!before) issues.push(issue('unknown_margin_position_detected', 'warning', 'margin_position', id, `Unrecognized remote margin position detected for ${position.symbol}.`));
    else {
      const fields = changedFields(before, position, ['symbol', 'positionSide', 'assetQuantity', 'liability', 'entryPrice', 'leverage']);
      if (fields.length > 0) issues.push(issue('margin_position_changed', 'warning', 'margin_position', id, `Remote margin position changed for ${position.symbol}.`, fields));
    }
  }
  for (const [id, position] of previousMargin) {
    if (!currentMargin.has(id)) issues.push(issue('margin_position_disappeared', 'warning', 'margin_position', id, `Previously observed margin position disappeared for ${position.symbol}.`));
  }

  const previousOrders = new Map(previous.openOrders.map((order) => [order.orderId, order]));
  const currentOrders = new Map(current.openOrders.map((order) => [order.orderId, order]));
  const currentFillOrderIds = new Set(current.recentFills.map((fill) => fill.orderId));
  for (const [id, order] of currentOrders) {
    if (!previousOrders.has(id)) issues.push(issue('unknown_order_detected', 'warning', 'order', id, `Unrecognized remote open order detected for ${order.symbol}.`));
  }
  for (const [id, order] of previousOrders) {
    if (currentOrders.has(id)) continue;
    if (currentFillOrderIds.has(id)) issues.push(issue('order_resolved_by_fill', 'info', 'order', id, `Previously open order has a matching recent fill for ${order.symbol}.`));
    else issues.push(issue('order_missing_without_fill', 'warning', 'order', id, `Previously open order disappeared without a matching recent fill for ${order.symbol}.`));
  }

  const previousFillIds = new Set(previous.recentFills.map((fill) => fill.transactionId));
  for (const fill of current.recentFills) {
    if (!previousFillIds.has(fill.transactionId)) issues.push(issue('new_fill_detected', 'info', 'fill', fill.transactionId, `New remote fill detected for ${fill.symbol}.`));
  }

  issues.sort((left, right) => left.code.localeCompare(right.code) || (left.entityId ?? '').localeCompare(right.entityId ?? ''));
  const ambiguousCodes = new Set<ReconciliationIssue['code']>([
    'account_configuration_changed', 'order_missing_without_fill',
    'futures_position_disappeared', 'margin_position_disappeared',
  ]);
  const status = issues.length === 0
    ? 'clean'
    : issues.some((entry) => ambiguousCodes.has(entry.code)) ? 'ambiguous' : 'changes_detected';
  return {
    id: reportId, createdAt, status, previousFetchedAt: previous.fetchedAt,
    currentFetchedAt: current.fetchedAt, issues,
  };
}

export function stalePortfolioReconciliation(
  reportId: string,
  createdAt: string,
  cached: PortfolioSnapshot,
): ReconciliationReport {
  return {
    id: reportId, createdAt, status: 'stale', previousFetchedAt: cached.fetchedAt,
    currentFetchedAt: cached.fetchedAt,
    issues: [issue('remote_refresh_failed', 'warning', 'system', null, 'Remote account refresh failed; the last validated snapshot is stale.')],
  };
}
