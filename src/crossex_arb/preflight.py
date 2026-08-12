from __future__ import annotations

import time
from dataclasses import asdict, dataclass
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR

from crossex_arb.models import (
    AccountState,
    OpenOrderState,
    Opportunity,
    OrderBook,
    PositionState,
    RiskLimit,
    SymbolRule,
)
from crossex_arb.strategy import quote_order_book


@dataclass(frozen=True)
class OrderDraft:
    text: str
    symbol: str
    side: str
    type: str
    time_in_force: str
    quantity: Decimal
    price: Decimal
    reduce_only: bool
    position_side: str


@dataclass(frozen=True)
class PreflightReport:
    approved: bool
    checked_at_ms: int
    opportunity_symbols: tuple[str, str]
    target_notional: Decimal
    position_mode: str
    account_mode: str
    checks: tuple[str, ...]
    blockers: tuple[str, ...]
    orders: tuple[OrderDraft, ...]

    def to_dict(self) -> dict[str, object]:
        data = asdict(self)
        data["opportunity_symbols"] = list(self.opportunity_symbols)
        for key in ("target_notional",):
            data[key] = str(data[key])
        data["orders"] = [
            {key: str(value) if isinstance(value, Decimal) else value for key, value in asdict(item).items()}
            for item in self.orders
        ]
        return data


def build_preflight_report(
    opportunity: Opportunity,
    books: list[OrderBook],
    rules: list[SymbolRule],
    account: AccountState,
    positions: list[PositionState],
    open_orders: list[OpenOrderState],
    risk_limits: list[RiskLimit],
    *,
    max_target_notional: Decimal,
    min_initial_margin_rate: Decimal,
    min_maintenance_margin_rate: Decimal,
    limit_slippage_bps: Decimal,
    max_account_age_ms: int,
    now_ms: int | None = None,
) -> PreflightReport:
    """生成只读 FOK 订单草案；任何未知值都会加入 blocker，绝不发送订单。"""
    checked_at = int(time.time() * 1000) if now_ms is None else now_ms
    symbols = (opportunity.long_symbol, opportunity.short_symbol)
    blockers: list[str] = []
    checks: list[str] = []
    if opportunity.execution_status != "EXECUTION_READY" or opportunity.market_data_quality != "LIVE_SYNCHRONIZED":
        blockers.append("候选行情不是持续维护且双腿同步的 execution-ready 订单簿")
    if opportunity.executable_quantity is None:
        blockers.append("候选缺少已验证的下单数量")
    target = opportunity.target_notional
    if target is None or target <= 0:
        blockers.append("候选缺少有效目标名义价值")
        target = Decimal(0)
    elif target > max_target_notional:
        blockers.append(f"目标名义价值 {target} 超过本地上限 {max_target_notional}")
    else:
        checks.append("目标名义价值未超过本地上限")
    age_ms = checked_at - account.update_time_ms
    if account.update_time_ms <= 0 or age_ms < 0 or age_ms > max_account_age_ms:
        blockers.append(f"账户快照时间无效或陈旧: {age_ms}ms")
    else:
        checks.append("账户快照新鲜")
    if account.available_margin <= 0 or account.margin_balance <= 0:
        blockers.append("可用保证金或保证金余额不为正")
    if account.initial_margin_rate < min_initial_margin_rate:
        blockers.append(f"初始保证金率 {account.initial_margin_rate} 低于阈值 {min_initial_margin_rate}")
    if account.maintenance_margin_rate < min_maintenance_margin_rate:
        blockers.append(f"维持保证金率 {account.maintenance_margin_rate} 低于阈值 {min_maintenance_margin_rate}")
    if account.position_mode not in {"SINGLE", "ONE_WAY", "DUAL"}:
        blockers.append(f"未识别的持仓模式 {account.position_mode}")
    if account.account_mode not in {"CROSS_EXCHANGE", "ISOLATED_EXCHANGE"}:
        blockers.append(f"未识别的账户模式 {account.account_mode}")

    active_positions = [item for item in positions if item.quantity != 0 and item.symbol in symbols]
    if active_positions:
        blockers.append("目标交易对已有持仓，自动加仓前必须人工对账")
    conflicting_orders = [item for item in open_orders if item.symbol in symbols and item.state in {"NEW", "OPEN", "PARTIALLY_FILLED"}]
    if conflicting_orders:
        blockers.append("目标交易对存在未完成订单")

    rule_map = {item.symbol: item for item in rules}
    book_map = {item.symbol: item for item in books}
    risk_map = {item.symbol: item for item in risk_limits}
    orders: list[OrderDraft] = []
    quantity = opportunity.executable_quantity or Decimal(0)
    for leg, symbol, side in (
        ("long", opportunity.long_symbol, "BUY"), ("short", opportunity.short_symbol, "SELL")
    ):
        rule = rule_map.get(symbol)
        book = book_map.get(symbol)
        risk = risk_map.get(symbol)
        if rule is None or rule.tick_size is None or rule.tick_size <= 0:
            blockers.append(f"{symbol} 缺少有效 tick_size")
            continue
        if book is None:
            blockers.append(f"{symbol} 缺少执行盘口")
            continue
        if risk is None or not risk.tiers:
            blockers.append(f"{symbol} 缺少风险档位")
            continue
        if not any(tier.min_value <= target <= tier.max_value for tier in risk.tiers):
            blockers.append(f"{symbol} 目标名义价值不在任何风险档位")
            continue
        try:
            quote = quote_order_book(book, side, quantity)
        except ValueError as exc:
            blockers.append(str(exc))
            continue
        multiplier = Decimal(1) + limit_slippage_bps / Decimal(10_000) if side == "BUY" else Decimal(1) - limit_slippage_bps / Decimal(10_000)
        raw_price = quote.worst_price * multiplier
        rounding = ROUND_CEILING if side == "BUY" else ROUND_FLOOR
        price = (raw_price / rule.tick_size).to_integral_value(rounding=rounding) * rule.tick_size
        position_side = "NONE" if account.position_mode in {"SINGLE", "ONE_WAY"} else ("LONG" if leg == "long" else "SHORT")
        orders.append(
            OrderDraft(
                text=f"cqpf-{checked_at}-{leg}", symbol=symbol, side=side, type="LIMIT", time_in_force="FOK",
                quantity=quantity, price=price, reduce_only=False, position_side=position_side,
            )
        )
    if len(orders) != 2:
        blockers.append("无法生成完整双腿订单草案")
    if limit_slippage_bps < 0:
        blockers.append("限价滑点保护不能为负数")
    return PreflightReport(
        approved=not blockers,
        checked_at_ms=checked_at,
        opportunity_symbols=symbols,
        target_notional=target,
        position_mode=account.position_mode,
        account_mode=account.account_mode,
        checks=tuple(checks), blockers=tuple(blockers), orders=tuple(orders) if not blockers else (),
    )
