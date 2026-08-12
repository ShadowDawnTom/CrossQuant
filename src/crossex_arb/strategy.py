from __future__ import annotations

import time
from collections import Counter, defaultdict
from dataclasses import replace
from decimal import Decimal, ROUND_DOWN
from itertools import combinations

from crossex_arb.models import (
    CandidateRejection,
    ExecutionQuote,
    FeeRate,
    FundingInfo,
    Opportunity,
    OrderBook,
    ScanResult,
    SymbolRule,
    Ticker,
)


def split_symbol(symbol: str) -> tuple[str, str, str, str]:
    """拆分 CrossEx 标识；基础币或计价币含下划线时需要人工复核。"""
    parts = symbol.split("_")
    if len(parts) != 4:
        raise ValueError(f"无法识别交易对标识: {symbol}")
    return parts[0], parts[1], parts[2], parts[3]


def _funding_event_count(item: FundingInfo, now_ms: int, horizon_ms: int) -> int:
    """按返回的下次结算时间和周期计数，不再假设两所同时结算。"""
    if item.interval_seconds <= 0:
        raise ValueError(f"{item.symbol} 的 funding_interval 无效")
    interval_ms = item.interval_seconds * 1000
    first_event_ms = item.next_time_ms
    if first_event_ms <= now_ms:
        first_event_ms += ((now_ms - first_event_ms) // interval_ms + 1) * interval_ms
    end_ms = now_ms + horizon_ms
    if first_event_ms > end_ms:
        return 0
    return (end_ms - first_event_ms) // interval_ms + 1


def _reject(
    rejections: list[CandidateRejection],
    base: str,
    quote: str,
    symbols: tuple[str, ...],
    reason: str,
    detail: str,
) -> None:
    rejections.append(CandidateRejection(base, quote, symbols, reason, detail))


def quote_order_book(book: OrderBook, side: str, quantity: Decimal) -> ExecutionQuote:
    """
    按基础币数量扫多档盘口并返回 VWAP。

    BUY 消耗 asks，SELL 消耗 bids；深度不够时直接报错，调用方不能按最后一档外推。
    """
    if side not in {"BUY", "SELL"}:
        raise ValueError("side 必须是 BUY 或 SELL")
    if quantity <= 0:
        raise ValueError("quantity 必须大于 0")
    levels = book.asks if side == "BUY" else book.bids
    remaining = quantity
    quote_amount = Decimal(0)
    worst_price: Decimal | None = None
    levels_used = 0
    for price, available in levels:
        if price <= 0 or available <= 0:
            raise ValueError(f"{book.symbol} 包含无效盘口档位")
        filled = min(remaining, available)
        if filled <= 0:
            continue
        quote_amount += filled * price
        remaining -= filled
        worst_price = price
        levels_used += 1
        if remaining == 0:
            break
    if remaining > 0 or worst_price is None:
        raise ValueError(f"{book.symbol} {side} 深度不足，缺少 {remaining} 基础币")
    return ExecutionQuote(side, quantity, quote_amount / quantity, quote_amount, worst_price, levels_used)


def _common_lot_size(first: Decimal | None, second: Decimal | None) -> Decimal | None:
    """将两个十进制步长转成同一整数尺度后求最小公倍数，确保两腿数量完全一致。"""
    if first is None or second is None or first <= 0 or second <= 0:
        return None
    scale = max(-first.as_tuple().exponent, -second.as_tuple().exponent, 0)
    multiplier = Decimal(10) ** scale
    first_int = int(first * multiplier)
    second_int = int(second * multiplier)
    from math import gcd

    return Decimal(first_int * second_int // gcd(first_int, second_int)) / multiplier


def _target_quantity(
    target_notional: Decimal,
    long_book: OrderBook,
    short_book: OrderBook,
    long_rule: SymbolRule,
    short_rule: SymbolRule,
) -> Decimal:
    """以两边更贵的入场价控制单腿预算，并按共同步长向下取整。"""
    if target_notional <= 0:
        raise ValueError("target_notional 必须大于 0")
    if not long_book.asks or not short_book.bids:
        raise ValueError("盘口缺少入场方向档位")
    raw = target_notional / max(long_book.asks[0][0], short_book.bids[0][0])
    common_lot = _common_lot_size(long_rule.lot_size, short_rule.lot_size)
    if common_lot is None:
        raise ValueError("两腿缺少有效 lot_size，无法生成等量订单")
    quantity = (raw / common_lot).to_integral_value(rounding=ROUND_DOWN) * common_lot
    if quantity <= 0:
        raise ValueError("目标金额小于共同下单步长")
    for rule in (long_rule, short_rule):
        if rule.min_size is None or rule.min_notional is None:
            raise ValueError(f"{rule.symbol} 缺少最小数量或最小名义价值规则")
        if quantity < rule.min_size:
            raise ValueError(f"{rule.symbol} 数量 {quantity} 小于最小数量 {rule.min_size}")
    return quantity


def find_opportunities(
    funding: list[FundingInfo],
    tickers: list[Ticker],
    fees: dict[str, FeeRate],
    rules: list[SymbolRule],
    scenario_horizon_hours: Decimal,
    slippage_bps_per_fill: Decimal,
    default_taker_fee: Decimal,
    max_mark_divergence: Decimal,
    assets: set[str] | None = None,
    quote: str = "USDT",
    *,
    order_books: list[OrderBook] | None = None,
    target_notional: Decimal | None = None,
    max_order_book_age_ms: int = 3_000,
    max_order_book_skew_ms: int = 1_000,
    max_ticker_age_ms: int = 10_000,
    max_ticker_skew_ms: int = 2_000,
    now_ms: int | None = None,
) -> ScanResult:
    """
    比较同币对的跨所合约，返回“当前费率保持不变”的现金流情景。

    未传 order_books 时只返回 mark-price 快照候选；传入后会按目标金额验证双边深度和 VWAP。
    """
    if scenario_horizon_hours <= 0:
        raise ValueError("scenario_horizon_hours 必须大于 0")
    if max_ticker_age_ms < 0 or max_ticker_skew_ms < 0:
        raise ValueError("行情时间阈值不能为负数")
    if max_order_book_age_ms < 0 or max_order_book_skew_ms < 0:
        raise ValueError("盘口时间阈值不能为负数")
    if order_books is not None and (target_notional is None or target_notional <= 0):
        raise ValueError("启用盘口校验时 target_notional 必须大于 0")
    scan_time_ms = int(time.time() * 1000) if now_ms is None else now_ms
    horizon_ms = int(scenario_horizon_hours * Decimal(3_600_000))

    ticker_counts = Counter(item.symbol for item in tickers)
    ticker_map = {item.symbol: item for item in tickers if ticker_counts[item.symbol] == 1}
    book_counts = Counter(item.symbol for item in order_books or [])
    book_map = {item.symbol: item for item in order_books or [] if book_counts[item.symbol] == 1}
    rule_map = {item.symbol: item for item in rules}
    live_symbols = {item.symbol for item in rules if item.business == "FUTURE" and item.state == "live"}
    groups: dict[tuple[str, str], list[FundingInfo]] = defaultdict(list)
    for item in funding:
        _, business, base, counter = split_symbol(item.symbol)
        if business != "FUTURE" or counter != quote or item.symbol not in live_symbols:
            continue
        if assets and base not in assets:
            continue
        groups[(base, counter)].append(item)

    opportunities: list[Opportunity] = []
    rejections: list[CandidateRejection] = []
    slip_cost = slippage_bps_per_fill / Decimal(10_000) * Decimal(4)
    for (base, counter), entries in groups.items():
        funding_counts = Counter(item.symbol for item in entries)
        unique_entries = [item for item in entries if funding_counts[item.symbol] == 1]
        for symbol, count in funding_counts.items():
            if count > 1:
                _reject(rejections, base, counter, (symbol,), "DUPLICATE_FUNDING", f"同一 symbol 返回 {count} 条资金费率")

        for first, second in combinations(unique_entries, 2):
            symbols = (first.symbol, second.symbol)
            first_exchange = split_symbol(first.symbol)[0]
            second_exchange = split_symbol(second.symbol)[0]
            if first_exchange == second_exchange:
                _reject(rejections, base, counter, symbols, "SAME_EXCHANGE", "两条数据来自同一交易所")
                continue

            invalid_ticker = False
            pair_tickers: list[Ticker] = []
            for symbol in symbols:
                if ticker_counts[symbol] > 1:
                    _reject(rejections, base, counter, symbols, "DUPLICATE_TICKER", f"{symbol} 返回了重复行情")
                    invalid_ticker = True
                    break
                ticker = ticker_map.get(symbol)
                if ticker is None or ticker.mark_price is None or ticker.mark_price <= 0 or ticker.timestamp_ms <= 0:
                    _reject(rejections, base, counter, symbols, "INVALID_TICKER", f"{symbol} 缺少有效 mark_price 或 timestamp")
                    invalid_ticker = True
                    break
                age_ms = scan_time_ms - ticker.timestamp_ms
                if age_ms < -max_ticker_skew_ms:
                    _reject(rejections, base, counter, symbols, "FUTURE_TICKER", f"{symbol} 行情时间超前 {-age_ms}ms")
                    invalid_ticker = True
                    break
                if age_ms > max_ticker_age_ms:
                    _reject(rejections, base, counter, symbols, "STALE_TICKER", f"{symbol} 行情已过期 {age_ms}ms")
                    invalid_ticker = True
                    break
                pair_tickers.append(ticker)
            if invalid_ticker:
                continue

            first_ticker, second_ticker = pair_tickers
            ticker_skew_ms = abs(first_ticker.timestamp_ms - second_ticker.timestamp_ms)
            if ticker_skew_ms > max_ticker_skew_ms:
                _reject(rejections, base, counter, symbols, "TICKER_TIME_SKEW", f"两所行情相差 {ticker_skew_ms}ms")
                continue
            midpoint = (first_ticker.mark_price + second_ticker.mark_price) / Decimal(2)
            divergence = abs(first_ticker.mark_price - second_ticker.mark_price) / midpoint
            if divergence > max_mark_divergence:
                _reject(rejections, base, counter, symbols, "MARK_DIVERGENCE", f"标记价偏离 {divergence} 超过阈值")
                continue

            first_events = _funding_event_count(first, scan_time_ms, horizon_ms)
            second_events = _funding_event_count(second, scan_time_ms, horizon_ms)
            first_total = first.rate * first_events
            second_total = second.rate * second_events
            long_leg, short_leg = (first, second) if first_total <= second_total else (second, first)
            long_events, short_events = (first_events, second_events) if long_leg is first else (second_events, first_events)
            long_ticker, short_ticker = (first_ticker, second_ticker) if long_leg is first else (second_ticker, first_ticker)
            long_exchange = split_symbol(long_leg.symbol)[0]
            short_exchange = split_symbol(short_leg.symbol)[0]
            long_fee = fees.get(long_exchange)
            short_fee = fees.get(short_exchange)
            long_taker = long_fee.taker_for(long_leg.symbol) if long_fee else default_taker_fee
            short_taker = short_fee.taker_for(short_leg.symbol) if short_fee else default_taker_fee

            # 正费率时多头支付、空头收取；负费率会自然反向计入现金流。
            long_cashflow = -long_leg.rate * long_events
            short_cashflow = short_leg.rate * short_events
            gross = long_cashflow + short_cashflow
            trading_cost = Decimal(2) * (long_taker + short_taker) + slip_cost
            net = gross - trading_cost
            opportunity = Opportunity(
                    asset=base,
                    quote=counter,
                    long_symbol=long_leg.symbol,
                    short_symbol=short_leg.symbol,
                    long_rate=long_leg.rate,
                    short_rate=short_leg.rate,
                    long_funding_events=long_events,
                    short_funding_events=short_events,
                    long_funding_cashflow=long_cashflow,
                    short_funding_cashflow=short_cashflow,
                    gross_snapshot_return=gross,
                    trading_cost_budget=trading_cost,
                    net_snapshot_return=net,
                    snapshot_annualized=net * Decimal(8760) / scenario_horizon_hours,
                    scenario_horizon_hours=scenario_horizon_hours,
                    mark_divergence=divergence,
                    ticker_time_skew_ms=ticker_skew_ms,
                    long_ticker_age_ms=scan_time_ms - long_ticker.timestamp_ms,
                    short_ticker_age_ms=scan_time_ms - short_ticker.timestamp_ms,
                    funding_times_aligned=abs(long_leg.next_time_ms - short_leg.next_time_ms) <= 60_000,
                )
            if order_books is not None:
                pair_books: list[OrderBook] = []
                invalid_book = False
                for symbol in (long_leg.symbol, short_leg.symbol):
                    if book_counts[symbol] > 1:
                        _reject(rejections, base, counter, symbols, "DUPLICATE_ORDER_BOOK", f"{symbol} 返回重复盘口")
                        invalid_book = True
                        break
                    book = book_map.get(symbol)
                    if book is None or not book.bids or not book.asks or book.timestamp_ms <= 0:
                        _reject(rejections, base, counter, symbols, "INVALID_ORDER_BOOK", f"{symbol} 缺少有效双边盘口")
                        invalid_book = True
                        break
                    age_ms = scan_time_ms - book.timestamp_ms
                    if age_ms < -max_order_book_skew_ms:
                        _reject(rejections, base, counter, symbols, "FUTURE_ORDER_BOOK", f"{symbol} 盘口时间超前 {-age_ms}ms")
                        invalid_book = True
                        break
                    if age_ms > max_order_book_age_ms:
                        _reject(rejections, base, counter, symbols, "STALE_ORDER_BOOK", f"{symbol} 盘口已过期 {age_ms}ms")
                        invalid_book = True
                        break
                    if book.bids[0][0] >= book.asks[0][0]:
                        _reject(rejections, base, counter, symbols, "CROSSED_ORDER_BOOK", f"{symbol} 买卖盘交叉")
                        invalid_book = True
                        break
                    pair_books.append(book)
                if invalid_book:
                    continue
                long_book, short_book = pair_books
                book_skew_ms = abs(long_book.timestamp_ms - short_book.timestamp_ms)
                if book_skew_ms > max_order_book_skew_ms:
                    _reject(rejections, base, counter, symbols, "ORDER_BOOK_TIME_SKEW", f"两所盘口相差 {book_skew_ms}ms")
                    continue
                try:
                    long_rule = rule_map[long_leg.symbol]
                    short_rule = rule_map[short_leg.symbol]
                    quantity = _target_quantity(target_notional, long_book, short_book, long_rule, short_rule)
                    long_entry = quote_order_book(long_book, "BUY", quantity)
                    short_entry = quote_order_book(short_book, "SELL", quantity)
                    long_exit = quote_order_book(long_book, "SELL", quantity)
                    short_exit = quote_order_book(short_book, "BUY", quantity)
                except (KeyError, ValueError) as exc:
                    _reject(rejections, base, counter, symbols, "INSUFFICIENT_EXECUTABLE_DEPTH", str(exc))
                    continue
                reference_notional = (long_entry.quote_amount + short_entry.quote_amount) / Decimal(2)
                for rule, entry in ((long_rule, long_entry), (short_rule, short_entry)):
                    if rule.min_notional is None or entry.quote_amount < rule.min_notional:
                        invalid_book = True
                        _reject(
                            rejections, base, counter, symbols, "BELOW_MIN_NOTIONAL",
                            f"{rule.symbol} 名义价值 {entry.quote_amount} 小于最小值 {rule.min_notional}",
                        )
                        break
                if invalid_book:
                    continue
                entry_basis = (short_entry.quote_amount - long_entry.quote_amount) / reference_notional
                exit_basis = (long_exit.quote_amount - short_exit.quote_amount) / reference_notional
                executable_funding = (
                    -long_leg.rate * long_events * long_entry.quote_amount
                    + short_leg.rate * short_events * short_entry.quote_amount
                ) / reference_notional
                executable_fees = (
                    long_entry.quote_amount * long_taker
                    + long_exit.quote_amount * long_taker
                    + short_entry.quote_amount * short_taker
                    + short_exit.quote_amount * short_taker
                ) / reference_notional
                executable_net = executable_funding + entry_basis + exit_basis - executable_fees
                opportunity = replace(
                    opportunity,
                    execution_status="EXECUTABLE_BOOK_VERIFIED",
                    target_notional=target_notional,
                    executable_quantity=quantity,
                    long_entry_vwap=long_entry.average_price,
                    short_entry_vwap=short_entry.average_price,
                    long_exit_vwap_estimate=long_exit.average_price,
                    short_exit_vwap_estimate=short_exit.average_price,
                    entry_basis_return=entry_basis,
                    exit_basis_return_estimate=exit_basis,
                    executable_funding_return=executable_funding,
                    executable_fee_return=executable_fees,
                    executable_net_snapshot_return=executable_net,
                    executable_snapshot_annualized=executable_net * Decimal(8760) / scenario_horizon_hours,
                    long_book_age_ms=scan_time_ms - long_book.timestamp_ms,
                    short_book_age_ms=scan_time_ms - short_book.timestamp_ms,
                    book_time_skew_ms=book_skew_ms,
                )
            opportunities.append(opportunity)
    opportunities.sort(
        key=lambda item: item.executable_snapshot_annualized
        if item.executable_snapshot_annualized is not None
        else item.snapshot_annualized,
        reverse=True,
    )
    return ScanResult(opportunities, rejections)
