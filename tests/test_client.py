import hashlib
import io
import json
import unittest
from decimal import Decimal
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from crossex_arb.client import GateAPIError, GateCrossExClient, build_signature, encode_query


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

    def test_malformed_api_fields_raise_controlled_error(self) -> None:
        class StubClient(GateCrossExClient):
            def _request(self, *args, **kwargs):
                return [{"symbol": "GATE_FUTURE_BTC_USDT", "funding_rate": "bad"}]

        with self.assertRaises(GateAPIError) as caught:
            StubClient("https://example.invalid").funding_info()
        self.assertEqual(caught.exception.label, "INVALID_RESPONSE")

    def test_rate_limit_error_preserves_status_and_label(self) -> None:
        body = json.dumps({"label": "TOO_MANY_REQUESTS", "message": "rate limit"}).encode("utf-8")
        error = HTTPError("https://example.invalid", 429, "Too Many Requests", {}, io.BytesIO(body))
        with patch("crossex_arb.client.urlopen", side_effect=error):
            with self.assertRaises(GateAPIError) as caught:
                GateCrossExClient("https://example.invalid").list_symbols()
        self.assertEqual(caught.exception.status, 429)
        self.assertEqual(caught.exception.label, "TOO_MANY_REQUESTS")

    def test_network_error_is_normalized(self) -> None:
        with patch("crossex_arb.client.urlopen", side_effect=URLError("offline")):
            with self.assertRaises(GateAPIError) as caught:
                GateCrossExClient("https://example.invalid").list_symbols()
        self.assertEqual(caught.exception.label, "NETWORK_ERROR")

    def test_account_positions_orders_and_risk_limits_are_strictly_parsed(self) -> None:
        class StubClient(GateCrossExClient):
            def _request(self, method, endpoint, *args, **kwargs):
                if endpoint == "/crossex/accounts":
                    return {
                        "available_margin": "100", "margin_balance": "120", "initial_margin_rate": "2",
                        "maintenance_margin_rate": "3", "position_mode": "SINGLE",
                        "account_mode": "CROSS_EXCHANGE", "exchange_type": "CROSSEX", "update_time": "1700000000000",
                    }
                if endpoint == "/crossex/positions":
                    return [{"symbol": "GATE_FUTURE_BTC_USDT", "position_side": "NONE", "position_qty": "0.1", "position_value": "10"}]
                if endpoint == "/crossex/open_orders":
                    return [{"order_id": "1", "symbol": "GATE_FUTURE_BTC_USDT", "state": "OPEN", "side": "BUY", "qty": "0.1"}]
                if endpoint == "/crossex/rule/risk_limits":
                    return [{"symbol": "GATE_FUTURE_BTC_USDT", "tiers": [{
                        "min_risk_limit_value": "0", "max_risk_limit_value": "1000",
                        "leverage_max": "20", "maintenance_rate": "0.005",
                    }]}]
                raise AssertionError(endpoint)

        client = StubClient("https://example.invalid")
        self.assertEqual(client.account_state().available_margin, Decimal("100"))
        self.assertEqual(client.positions()[0].quantity, Decimal("0.1"))
        self.assertEqual(client.open_orders()[0].state, "OPEN")
        self.assertEqual(client.risk_limits(["GATE_FUTURE_BTC_USDT"])[0].tiers[0].max_leverage, Decimal("20"))

    def test_invalid_account_field_fails_closed(self) -> None:
        class StubClient(GateCrossExClient):
            def _request(self, *args, **kwargs):
                return {"available_margin": "bad"}

        with self.assertRaises(GateAPIError) as caught:
            StubClient("https://example.invalid").account_state()
        self.assertEqual(caught.exception.label, "INVALID_RESPONSE")


if __name__ == "__main__":
    unittest.main()
