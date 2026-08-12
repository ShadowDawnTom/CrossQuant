import unittest
from decimal import Decimal
from unittest.mock import patch

from crossex_arb.market_depth import MarketDepthError, collect_order_books, fetch_order_book


class MarketDepthTests(unittest.TestCase):
    def test_gate_contract_quantity_is_converted_to_base_coin(self):
        responses = [
            {"current": 1_700_000_000.25, "bids": [{"p": "99", "s": 2000}], "asks": [{"p": "101", "s": 3000}]},
            {"quanto_multiplier": "0.001"},
        ]
        with patch("crossex_arb.market_depth._json_get", side_effect=responses):
            book = fetch_order_book("GATE_FUTURE_BTC_USDT", 1)
        self.assertEqual(book.bids[0], (Decimal("99"), Decimal("2.000")))
        self.assertEqual(book.asks[0], (Decimal("101"), Decimal("3.000")))

    def test_okx_contract_quantity_is_converted_with_ctval(self):
        responses = [
            {"code": "0", "data": [{"ts": "1700000000000", "bids": [["99", "20", "0", "1"]], "asks": [["101", "30", "0", "1"]]}]},
            {"code": "0", "data": [{"ctVal": "0.01", "ctValCcy": "BTC"}]},
        ]
        with patch("crossex_arb.market_depth._json_get", side_effect=responses):
            book = fetch_order_book("OKX_FUTURE_BTC_USDT", 1)
        self.assertEqual(book.bids[0][1], Decimal("0.20"))

    def test_unsupported_venue_is_reported_without_breaking_supported_books(self):
        with patch("crossex_arb.market_depth.fetch_order_book") as fetch:
            fetch.return_value = fetch_order_book_from_fixture()
            books, errors = collect_order_books(
                ["BINANCE_FUTURE_BTC_USDT", "DERIBIT_FUTURE_BTC_USDT"], 1, workers=1
            )
        self.assertEqual(len(books), 1)
        self.assertIn("DERIBIT_FUTURE_BTC_USDT", errors)

    def test_crossed_book_is_rejected(self):
        responses = [
            {"E": 1_700_000_000_000, "bids": [["102", "1"]], "asks": [["101", "1"]]},
        ]
        with patch("crossex_arb.market_depth._json_get", side_effect=responses):
            with self.assertRaisesRegex(MarketDepthError, "交叉"):
                fetch_order_book("BINANCE_FUTURE_BTC_USDT", 1)


def fetch_order_book_from_fixture():
    from crossex_arb.models import OrderBook

    return OrderBook(
        "BINANCE_FUTURE_BTC_USDT",
        ((Decimal("99"), Decimal("1")),),
        ((Decimal("101"), Decimal("1")),),
        1_700_000_000_000,
        "fixture",
    )


if __name__ == "__main__":
    unittest.main()
