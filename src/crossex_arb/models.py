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

    @property
    def hourly_rate(self) -> Decimal:
        if self.interval_seconds <= 0:
            raise ValueError(f"{self.symbol} 的 funding_interval 无效")
        return self.rate / (Decimal(self.interval_seconds) / Decimal(3600))


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
class Opportunity:
    asset: str
    quote: str
    long_symbol: str
    short_symbol: str
    long_rate: Decimal
    short_rate: Decimal
    gross_return: Decimal
    trading_cost: Decimal
    net_return: Decimal
    net_annualized: Decimal
    mark_divergence: Decimal | None
    funding_times_aligned: bool

    def to_dict(self) -> dict[str, object]:
        data = asdict(self)
        for key, value in tuple(data.items()):
            if isinstance(value, Decimal):
                data[key] = str(value)
        return data
