import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from crossex_arb.history import append_market_snapshot, load_market_snapshots
from crossex_arb.models import FeeRate, FundingInfo, Ticker


class HistoryTests(unittest.TestCase):
    def test_snapshot_round_trip_is_utf8_jsonl_with_lf(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshots.jsonl"
            append_market_snapshot(
                path,
                [FundingInfo("GATE_FUTURE_BTC_USDT", Decimal("0.001"), 2_000, 3_600)],
                [Ticker("GATE_FUTURE_BTC_USDT", Decimal("100"), Decimal("100"), 1_000)],
                {"GATE": FeeRate("GATE", Decimal("0.0005"), {})},
                collected_at_ms=1_500,
            )
            raw = path.read_bytes()
            self.assertNotEqual(raw[:3], b"\xef\xbb\xbf")
            self.assertTrue(raw.endswith(b"\n"))
            self.assertNotIn(b"\r\n", raw)
            rows = load_market_snapshots(path)
            self.assertEqual(rows[0]["funding"][0]["rate"], "0.001")


if __name__ == "__main__":
    unittest.main()
