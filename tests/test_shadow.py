import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from crossex_arb.models import Opportunity, OrderBook
from crossex_arb.shadow import ShadowExecutionEngine, ShadowStore


def opportunity() -> Opportunity:
    return Opportunity(
        asset="BTC", quote="USDT", long_symbol="BINANCE_FUTURE_BTC_USDT",
        short_symbol="GATE_FUTURE_BTC_USDT", long_rate=Decimal("0"), short_rate=Decimal("0.001"),
        long_funding_events=3, short_funding_events=3, long_funding_cashflow=Decimal("0"),
        short_funding_cashflow=Decimal("0.003"), gross_snapshot_return=Decimal("0.003"),
        trading_cost_budget=Decimal("0.001"), net_snapshot_return=Decimal("0.002"),
        snapshot_annualized=Decimal("0.73"), scenario_horizon_hours=Decimal("24"),
        mark_divergence=Decimal("0"), ticker_time_skew_ms=10, long_ticker_age_ms=10,
        short_ticker_age_ms=10, funding_times_aligned=True, execution_status="EXECUTABLE_BOOK_VERIFIED",
        executable_quantity=Decimal("1"), target_notional=Decimal("100"),
    )


def books(short_depth: Decimal = Decimal("2")) -> list[OrderBook]:
    return [
        OrderBook("BINANCE_FUTURE_BTC_USDT", ((Decimal("99"), Decimal("2")),), ((Decimal("100"), Decimal("2")),), 1),
        OrderBook("GATE_FUTURE_BTC_USDT", ((Decimal("101"), short_depth),), ((Decimal("102"), Decimal("2")),), 1),
    ]


class ShadowExecutionTests(unittest.TestCase):
    def test_two_full_legs_open_and_idempotency_returns_same_trade(self):
        with tempfile.TemporaryDirectory() as directory, ShadowStore(Path(directory) / "shadow.db") as store:
            engine = ShadowExecutionEngine(store)
            first = engine.open(opportunity(), books(), idempotency_key="same", now_ms=100)
            second = engine.open(opportunity(), books(), idempotency_key="same", now_ms=200)
            self.assertEqual(first.state, "OPEN")
            self.assertEqual(first.trade_id, second.trade_id)
            self.assertEqual(len(store.list_trades()), 1)

            closed = engine.close(first.trade_id, books(), now_ms=300)
            self.assertEqual(closed.state, "CLOSED")
            self.assertEqual(closed.open_quantity, Decimal(0))
            self.assertEqual(closed.gross_execution_cashflow, Decimal("-2"))

    def test_partial_leg_repairs_exposure_and_keeps_matched_position(self):
        with tempfile.TemporaryDirectory() as directory, ShadowStore(Path(directory) / "shadow.db") as store:
            result = ShadowExecutionEngine(store).open(
                opportunity(), books(), idempotency_key="partial", short_fill_ratio=Decimal("0.4"), now_ms=100
            )
            self.assertEqual(result.state, "OPEN_PARTIAL")
            self.assertEqual(result.net_base_exposure, Decimal(0))
            self.assertEqual(result.open_quantity, Decimal("0.4"))
            self.assertEqual([item.leg for item in result.fills], ["LONG_OPEN", "SHORT_OPEN", "REPAIR"])

    def test_repair_failure_requires_manual_intervention(self):
        damaged = books()
        damaged[0] = OrderBook(
            damaged[0].symbol, ((Decimal("99"), Decimal("0.1")),), damaged[0].asks, damaged[0].timestamp_ms
        )
        with tempfile.TemporaryDirectory() as directory, ShadowStore(Path(directory) / "shadow.db") as store:
            result = ShadowExecutionEngine(store).open(
                opportunity(), damaged, idempotency_key="repair-fail", short_fill_ratio=Decimal("0.4"), now_ms=100
            )
            self.assertEqual(result.state, "MANUAL_INTERVENTION")
            self.assertEqual(result.net_base_exposure, Decimal("0.6"))
            self.assertEqual(result.open_quantity, Decimal("0.4"))

    def test_one_leg_rejection_repairs_filled_leg_to_flat(self):
        with tempfile.TemporaryDirectory() as directory, ShadowStore(Path(directory) / "shadow.db") as store:
            result = ShadowExecutionEngine(store).open(
                opportunity(), books(short_depth=Decimal("0.1")), idempotency_key="one-reject", now_ms=100
            )
            self.assertEqual(result.state, "ABORTED_FLAT")
            self.assertEqual(result.net_base_exposure, Decimal(0))
            self.assertEqual(result.fills[1].status, "REJECTED")

    def test_partial_close_never_reports_closed(self):
        with tempfile.TemporaryDirectory() as directory, ShadowStore(Path(directory) / "shadow.db") as store:
            engine = ShadowExecutionEngine(store)
            opened = engine.open(opportunity(), books(), idempotency_key="partial-close", now_ms=100)
            result = engine.close(opened.trade_id, books(), short_fill_ratio=Decimal("0.5"), now_ms=200)
            self.assertEqual(result.state, "MANUAL_INTERVENTION")
            self.assertEqual(result.net_base_exposure, Decimal("-0.5"))


if __name__ == "__main__":
    unittest.main()
