import unittest
from decimal import Decimal

from crossex_arb.models import FeeRate, FundingInfo, SymbolRule, Ticker
from crossex_arb.strategy import find_opportunities


NOW_MS = 1_700_000_000_000


def rule(symbol: str) -> SymbolRule:
    return SymbolRule(symbol, symbol.split("_")[0], "FUTURE", "live", Decimal("0.001"), Decimal("5"), Decimal("0.001"))


def scan(
    funding: list[FundingInfo],
    tickers: list[Ticker],
    fees: dict[str, FeeRate] | None = None,
):
    return find_opportunities(
        funding,
        tickers,
        fees or {},
        [rule(item.symbol) for item in funding],
        Decimal("24"),
        Decimal("0"),
        Decimal("0"),
        Decimal("0.003"),
        now_ms=NOW_MS,
    )


class StrategyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.binance = "BINANCE_FUTURE_BTC_USDT"
        self.gate = "GATE_FUTURE_BTC_USDT"

    def valid_tickers(self, first_ms: int = NOW_MS - 500, second_ms: int = NOW_MS - 700) -> list[Ticker]:
        return [
            Ticker(self.binance, Decimal("100"), Decimal("100"), first_ms),
            Ticker(self.gate, Decimal("100"), Decimal("100.01"), second_ms),
        ]

    def test_simulates_each_settlement_event_and_deducts_four_fills(self) -> None:
        funding = [
            FundingInfo(self.binance, Decimal("0.0001"), NOW_MS + 28_800_000, 28_800),
            FundingInfo(self.gate, Decimal("0.0001"), NOW_MS + 3_600_000, 3_600),
        ]
        fees = {
            "BINANCE": FeeRate("BINANCE", Decimal("0.0002"), {}),
            "GATE": FeeRate("GATE", Decimal("0.0003"), {}),
        }
        result = scan(funding, self.valid_tickers(), fees)
        row = result.opportunities[0]
        self.assertEqual((row.long_funding_events, row.short_funding_events), (3, 24))
        self.assertEqual(row.gross_snapshot_return, Decimal("0.0021"))
        self.assertEqual(row.trading_cost_budget, Decimal("0.0010"))
        self.assertEqual(row.net_snapshot_return, Decimal("0.0011"))
        self.assertEqual(row.execution_status, "UNVERIFIED_NO_ORDER_BOOK")

    def test_misaligned_settlement_times_change_cashflow_count(self) -> None:
        funding = [
            FundingInfo(self.binance, Decimal("0"), NOW_MS + 28_800_000, 28_800),
            FundingInfo(self.gate, Decimal("0.001"), NOW_MS + 32_400_000, 28_800),
        ]
        row = scan(funding, self.valid_tickers()).opportunities[0]
        self.assertFalse(row.funding_times_aligned)
        self.assertEqual((row.long_funding_events, row.short_funding_events), (3, 2))
        self.assertEqual(row.gross_snapshot_return, Decimal("0.002"))

    def test_negative_funding_rates_follow_payment_direction(self) -> None:
        funding = [
            FundingInfo(self.binance, Decimal("-0.0002"), NOW_MS + 28_800_000, 28_800),
            FundingInfo(self.gate, Decimal("-0.0001"), NOW_MS + 28_800_000, 28_800),
        ]
        row = scan(funding, self.valid_tickers()).opportunities[0]
        self.assertEqual(row.long_symbol, self.binance)
        self.assertEqual(row.long_funding_cashflow, Decimal("0.0006"))
        self.assertEqual(row.short_funding_cashflow, Decimal("-0.0003"))
        self.assertEqual(row.gross_snapshot_return, Decimal("0.0003"))

    def test_uses_symbol_specific_fee(self) -> None:
        funding = [
            FundingInfo(self.binance, Decimal("0"), NOW_MS + 28_800_000, 28_800),
            FundingInfo(self.gate, Decimal("0.001"), NOW_MS + 28_800_000, 28_800),
        ]
        fees = {
            "BINANCE": FeeRate("BINANCE", Decimal("0.001"), {self.binance: Decimal("0.0001")}),
            "GATE": FeeRate("GATE", Decimal("0.0002"), {}),
        }
        row = scan(funding, self.valid_tickers(), fees).opportunities[0]
        self.assertEqual(row.trading_cost_budget, Decimal("0.0006"))

    def test_missing_mark_price_is_rejected(self) -> None:
        funding = [
            FundingInfo(self.binance, Decimal("0"), NOW_MS + 1_000, 3_600),
            FundingInfo(self.gate, Decimal("0.001"), NOW_MS + 1_000, 3_600),
        ]
        tickers = self.valid_tickers()
        tickers[0] = Ticker(self.binance, Decimal("100"), None, NOW_MS - 500)
        result = scan(funding, tickers)
        self.assertEqual(result.opportunities, [])
        self.assertEqual(result.rejections[0].reason, "INVALID_TICKER")

    def test_stale_and_skewed_tickers_are_rejected(self) -> None:
        funding = [
            FundingInfo(self.binance, Decimal("0"), NOW_MS + 1_000, 3_600),
            FundingInfo(self.gate, Decimal("0.001"), NOW_MS + 1_000, 3_600),
        ]
        stale = scan(funding, self.valid_tickers(NOW_MS - 10_001, NOW_MS - 700))
        self.assertEqual(stale.rejections[0].reason, "STALE_TICKER")
        skewed = scan(funding, self.valid_tickers(NOW_MS - 100, NOW_MS - 2_101))
        self.assertEqual(skewed.rejections[0].reason, "TICKER_TIME_SKEW")

    def test_large_mark_divergence_is_rejected(self) -> None:
        funding = [
            FundingInfo(self.binance, Decimal("0"), NOW_MS + 1_000, 28_800),
            FundingInfo(self.gate, Decimal("0.001"), NOW_MS + 1_000, 28_800),
        ]
        tickers = [
            Ticker(self.binance, None, Decimal("100"), NOW_MS - 100),
            Ticker(self.gate, None, Decimal("102"), NOW_MS - 100),
        ]
        result = scan(funding, tickers)
        self.assertEqual(result.opportunities, [])
        self.assertEqual(result.rejections[0].reason, "MARK_DIVERGENCE")

    def test_duplicate_exchange_and_duplicate_ticker_are_rejected(self) -> None:
        bybit_a = "BYBIT_FUTURE_BTC_USDT"
        bybit_b = "BYBIT_FUTURE_BTC_USDT"
        funding = [
            FundingInfo(bybit_a, Decimal("0"), NOW_MS + 1_000, 3_600),
            FundingInfo(bybit_b, Decimal("0.001"), NOW_MS + 1_000, 3_600),
        ]
        result = scan(funding, [Ticker(bybit_a, None, Decimal("100"), NOW_MS - 100)])
        self.assertEqual(result.opportunities, [])
        self.assertEqual(result.rejections[0].reason, "DUPLICATE_FUNDING")

        normal_funding = [
            FundingInfo(self.binance, Decimal("0"), NOW_MS + 1_000, 3_600),
            FundingInfo(self.gate, Decimal("0.001"), NOW_MS + 1_000, 3_600),
        ]
        tickers = self.valid_tickers() + [Ticker(self.binance, None, Decimal("100"), NOW_MS - 50)]
        duplicate = scan(normal_funding, tickers)
        self.assertEqual(duplicate.rejections[0].reason, "DUPLICATE_TICKER")


if __name__ == "__main__":
    unittest.main()
