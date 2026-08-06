from __future__ import annotations

from collections import defaultdict
from decimal import Decimal
from itertools import combinations

from crossex_arb.models import FeeRate, FundingInfo, Opportunity, SymbolRule, Ticker


def split_symbol(symbol: str) -> tuple[str, str, str, str]:
    """拆分 CrossEx 标识；基础币或计价币含下划线时需要人工复核。"""
    parts = symbol.split("_")
    if len(parts) != 4:
        raise ValueError(f"无法识别交易对标识: {symbol}")
    return parts[0], parts[1], parts[2], parts[3]


def find_opportunities(
    funding: list[FundingInfo],
    tickers: list[Ticker],
    fees: dict[str, FeeRate],
    rules: list[SymbolRule],
    holding_hours: Decimal,
    slippage_bps_per_fill: Decimal,
    default_taker_fee: Decimal,
    max_mark_divergence: Decimal,
    assets: set[str] | None = None,
    quote: str = "USDT",
) -> list[Opportunity]:
    """比较同币对的不同交易所合约，返回扣除开平成本后的候选机会。"""
    ticker_map = {item.symbol: item for item in tickers}
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
    slip_cost = slippage_bps_per_fill / Decimal(10_000) * Decimal(4)
    for (base, counter), entries in groups.items():
        for first, second in combinations(entries, 2):
            long_leg, short_leg = (first, second) if first.hourly_rate <= second.hourly_rate else (second, first)
            long_exchange = split_symbol(long_leg.symbol)[0]
            short_exchange = split_symbol(short_leg.symbol)[0]
            long_fee = fees.get(long_exchange)
            short_fee = fees.get(short_exchange)
            long_taker = long_fee.taker_for(long_leg.symbol) if long_fee else default_taker_fee
            short_taker = short_fee.taker_for(short_leg.symbol) if short_fee else default_taker_fee
            gross = (short_leg.hourly_rate - long_leg.hourly_rate) * holding_hours
            trading_cost = Decimal(2) * (long_taker + short_taker) + slip_cost
            net = gross - trading_cost

            long_mark = ticker_map.get(long_leg.symbol)
            short_mark = ticker_map.get(short_leg.symbol)
            divergence: Decimal | None = None
            if long_mark and short_mark and long_mark.mark_price and short_mark.mark_price:
                midpoint = (long_mark.mark_price + short_mark.mark_price) / Decimal(2)
                divergence = abs(long_mark.mark_price - short_mark.mark_price) / midpoint if midpoint else None
            if divergence is not None and divergence > max_mark_divergence:
                continue

            opportunities.append(
                Opportunity(
                    asset=base, quote=counter, long_symbol=long_leg.symbol, short_symbol=short_leg.symbol,
                    long_rate=long_leg.rate, short_rate=short_leg.rate, gross_return=gross,
                    trading_cost=trading_cost, net_return=net,
                    net_annualized=net * Decimal(8760) / holding_hours,
                    mark_divergence=divergence,
                    funding_times_aligned=abs(long_leg.next_time_ms - short_leg.next_time_ms) <= 60_000,
                )
            )
    return sorted(opportunities, key=lambda item: item.net_annualized, reverse=True)

