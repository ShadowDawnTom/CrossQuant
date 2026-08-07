from __future__ import annotations

import time
from collections import Counter, defaultdict
from decimal import Decimal
from itertools import combinations

from crossex_arb.models import (
    CandidateRejection,
    FeeRate,
    FundingInfo,
    Opportunity,
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
    max_ticker_age_ms: int = 10_000,
    max_ticker_skew_ms: int = 2_000,
    now_ms: int | None = None,
) -> ScanResult:
    """
    比较同币对的跨所合约，返回“当前费率保持不变”的现金流情景。

    返回值只是候选扫描；CrossEx 没有提供这里所需的双边订单簿，因此不代表可成交收益。
    """
    if scenario_horizon_hours <= 0:
        raise ValueError("scenario_horizon_hours 必须大于 0")
    if max_ticker_age_ms < 0 or max_ticker_skew_ms < 0:
        raise ValueError("行情时间阈值不能为负数")
    scan_time_ms = int(time.time() * 1000) if now_ms is None else now_ms
    horizon_ms = int(scenario_horizon_hours * Decimal(3_600_000))

    ticker_counts = Counter(item.symbol for item in tickers)
    ticker_map = {item.symbol: item for item in tickers if ticker_counts[item.symbol] == 1}
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
            opportunities.append(
                Opportunity(
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
            )
    opportunities.sort(key=lambda item: item.snapshot_annualized, reverse=True)
    return ScanResult(opportunities, rejections)
