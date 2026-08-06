import hashlib
import unittest

from crossex_arb.client import GateCrossExClient, build_signature, encode_query


class SignatureTests(unittest.TestCase):
    def test_official_empty_body_hash(self) -> None:
        timestamp, signature = build_signature(
            secret="secret",
            method="GET",
            path="/api/v4/futures/orders",
            query_string="contract=BTC_USD&status=finished&limit=50",
            timestamp="1541993715",
        )
        self.assertEqual(timestamp, "1541993715")
        self.assertEqual(hashlib.sha512(b"").hexdigest(), "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e")
        self.assertEqual(signature, "55f84ea195d6fe57ce62464daaa7c3c02fa9d1dde954e4c898289c9a2407a3d6fb3faf24deff16790d726b66ac9f74526668b13bd01029199cc4fcc522418b8a")

    def test_symbol_rule_keeps_nullable_limits_unknown(self) -> None:
        class StubClient(GateCrossExClient):
            def _request(self, *args, **kwargs):
                return [{
                    "symbol": "GATE_FUTURE_BTC_USDT", "exchange_type": "GATE",
                    "business_type": "FUTURE", "state": "live", "min_size": "0.001",
                    "min_notional": None, "lot_size": None,
                }]

        row = StubClient("https://example.invalid").list_symbols()[0]
        self.assertIsNone(row.min_notional)
        self.assertIsNone(row.lot_size)

    def test_symbols_query_keeps_commas_for_signature(self) -> None:
        query = encode_query([("symbols", "BINANCE_FUTURE_BTC_USDT,GATE_FUTURE_BTC_USDT")])
        self.assertEqual(query, "symbols=BINANCE_FUTURE_BTC_USDT,GATE_FUTURE_BTC_USDT")


if __name__ == "__main__":
    unittest.main()
