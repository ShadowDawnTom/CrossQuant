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
        return {
            "model": "current_funding_snapshot_cashflow_scenario",
            "executable": False,
            "opportunities": [item.to_dict() for item in self.opportunities],
            "rejections": [item.to_dict() for item in self.rejections],
        }
