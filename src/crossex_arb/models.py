from __future__ import annotations

from dataclasses import asdict, dataclass
from decimal import Decimal


@dataclass(frozen=True)
class SymbolRule:
    symbol: str
    exchange: str
    business: str
    state: str
    min_size: Decimal | None
    min_notional: Decimal | None
    lot_size: Decimal | None
    tick_size: Decimal | None = None
    max_market_size: Decimal | None = None
    max_limit_size: Decimal | None = None


@dataclass(frozen=True)
class FundingInfo:
    symbol: str
    rate: Decimal
    next_time_ms: int
    interval_seconds: int


@dataclass(frozen=True)
class Ticker:
    symbol: str
    last_price: Decimal | None
    mark_price: Decimal | None
    timestamp_ms: int


@dataclass(frozen=True)
class OrderBook:
    symbol: str
    bids: tuple[tuple[Decimal, Decimal], ...]
    asks: tuple[tuple[Decimal, Decimal], ...]
    timestamp_ms: int
    source: str = "gate_crossex_websocket"


@dataclass(frozen=True)
class ExecutionQuote:
    side: str
    quantity: Decimal
    average_price: Decimal
    quote_amount: Decimal
    worst_price: Decimal
    levels_used: int


@dataclass(frozen=True)
class AccountState:
    available_margin: Decimal
    margin_balance: Decimal
    initial_margin_rate: Decimal
    maintenance_margin_rate: Decimal
    position_mode: str
    account_mode: str
    exchange_type: str
    update_time_ms: int


@dataclass(frozen=True)
class PositionState:
    symbol: str
    position_side: str
    quantity: Decimal
    value: Decimal


@dataclass(frozen=True)
class OpenOrderState:
    order_id: str
    symbol: str
    state: str
    side: str
    quantity: Decimal


@dataclass(frozen=True)
class RiskTier:
    min_value: Decimal
    max_value: Decimal
    max_leverage: Decimal
    maintenance_rate: Decimal


@dataclass(frozen=True)
class RiskLimit:
    symbol: str
    tiers: tuple[RiskTier, ...]


@dataclass(frozen=True)
class FeeRate:
    exchange: str
    future_taker: Decimal
    special_taker: dict[str, Decimal]

    def taker_for(self, symbol: str) -> Decimal:
        return self.special_taker.get(symbol, self.future_taker)


@dataclass(frozen=True)
class CandidateRejection:
    asset: str
    quote: str
    symbols: tuple[str, ...]
    reason: str
    detail: str

    def to_dict(self) -> dict[str, object]:
        data = asdict(self)
        data["symbols"] = list(self.symbols)
        return data


@dataclass(frozen=True)
class Opportunity:
    asset: str
    quote: str
    long_symbol: str
    short_symbol: str
    long_rate: Decimal
    short_rate: Decimal
    long_funding_events: int
    short_funding_events: int
    long_funding_cashflow: Decimal
    short_funding_cashflow: Decimal
    gross_snapshot_return: Decimal
    trading_cost_budget: Decimal
    net_snapshot_return: Decimal
    snapshot_annualized: Decimal
    scenario_horizon_hours: Decimal
    mark_divergence: Decimal
    ticker_time_skew_ms: int
    long_ticker_age_ms: int
    short_ticker_age_ms: int
    funding_times_aligned: bool
    execution_status: str = "UNVERIFIED_NO_ORDER_BOOK"
    target_notional: Decimal | None = None
    executable_quantity: Decimal | None = None
    long_entry_vwap: Decimal | None = None
    short_entry_vwap: Decimal | None = None
    long_exit_vwap_estimate: Decimal | None = None
    short_exit_vwap_estimate: Decimal | None = None
    entry_basis_return: Decimal | None = None
    exit_basis_return_estimate: Decimal | None = None
    executable_funding_return: Decimal | None = None
    executable_fee_return: Decimal | None = None
    executable_net_snapshot_return: Decimal | None = None
    executable_snapshot_annualized: Decimal | None = None
    long_book_age_ms: int | None = None
    short_book_age_ms: int | None = None
    book_time_skew_ms: int | None = None

    def to_dict(self) -> dict[str, object]:
        data = asdict(self)
        for key, value in tuple(data.items()):
            if isinstance(value, Decimal):
                data[key] = str(value)
        return data


@dataclass(frozen=True)
class ScanResult:
    opportunities: list[Opportunity]
    rejections: list[CandidateRejection]

    def to_dict(self) -> dict[str, object]:
        executable = bool(self.opportunities) and all(
            item.execution_status == "EXECUTABLE_BOOK_VERIFIED" for item in self.opportunities
        )
        return {
            "model": "current_funding_snapshot_cashflow_scenario",
            "executable": executable,
            "opportunities": [item.to_dict() for item in self.opportunities],
            "rejections": [item.to_dict() for item in self.rejections],
        }
