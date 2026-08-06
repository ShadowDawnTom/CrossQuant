import unittest
from decimal import Decimal

from crossex_arb.models import FeeRate, FundingInfo, SymbolRule, Ticker
from crossex_arb.strategy import find_opportunities


class StrategyTests(unittest.TestCase):
    def test_normalizes_intervals_and_deducts_four_fills(self) -> None:
        funding = [
            FundingInfo("BINANCE_FUTURE_BTC_USDT", Decimal("0.0001"), 1_800_000_000_000, 28_800),
            FundingInfo("GATE_FUTURE_BTC_USDT", Decimal("0.0001"), 1_800_000_000_000, 3_600),
        ]
        tickers = [
            Ticker("BINANCE_FUTURE_BTC_USDT", Decimal("100"), Decimal("100"), 1),
            Ticker("GATE_FUTURE_BTC_USDT", Decimal("100"), Decimal("100.01"), 1),
        ]
        rules = [
            SymbolRule(item.symbol, item.symbol.split("_")[0], "FUTURE", "live", Decimal("0.001"), Decimal("5"), Decimal("0.001"))
            for item in funding
        ]
        fees = {
            "BINANCE": FeeRate("BINANCE", Decimal("0.0002"), {}),
            "GATE": FeeRate("GATE", Decimal("0.0003"), {}),
        }
        rows = find_opportunities(
            funding, tickers, fees, rules, Decimal("24"), Decimal("2"), Decimal("0.0005"), Decimal("0.003"), {"BTC"}, "USDT"
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].long_symbol, "BINANCE_FUTURE_BTC_USDT")
        self.assertEqual(rows[0].short_symbol, "GATE_FUTURE_BTC_USDT")
        self.assertEqual(rows[0].gross_return, Decimal("0.0021"))
        self.assertEqual(rows[0].trading_cost, Decimal("0.0018"))
        self.assertEqual(rows[0].net_return, Decimal("0.0003"))

    def test_filters_large_mark_divergence(self) -> None:
        funding = [
            FundingInfo("BINANCE_FUTURE_ETH_USDT", Decimal("0"), 1000, 28_800),
            FundingInfo("GATE_FUTURE_ETH_USDT", Decimal("0.001"), 1000, 28_800),
        ]
        tickers = [
            Ticker("BINANCE_FUTURE_ETH_USDT", None, Decimal("100"), 1),
            Ticker("GATE_FUTURE_ETH_USDT", None, Decimal("102"), 1),
        ]
        rules = [
            SymbolRule(item.symbol, item.symbol.split("_")[0], "FUTURE", "live", Decimal("1"), Decimal("5"), Decimal("1"))
            for item in funding
        ]
        rows = find_opportunities(funding, tickers, {}, rules, Decimal("24"), Decimal("0"), Decimal("0"), Decimal("0.003"))
        self.assertEqual(rows, [])


if __name__ == "__main__":
    unittest.main()
