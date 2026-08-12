import unittest
from decimal import Decimal

from crossex_arb.models import AccountState, Opportunity, OrderBook, RiskLimit, RiskTier, SymbolRule
from crossex_arb.preflight import build_preflight_report


NOW = 1_700_000_000_000
LONG = "BINANCE_FUTURE_BTC_USDT"
SHORT = "GATE_FUTURE_BTC_USDT"


def opportunity():
    return Opportunity(
        asset="BTC", quote="USDT", long_symbol=LONG, short_symbol=SHORT,
        long_rate=Decimal("0"), short_rate=Decimal("0.001"), long_funding_events=3,
        short_funding_events=3, long_funding_cashflow=Decimal(0), short_funding_cashflow=Decimal("0.003"),
        gross_snapshot_return=Decimal("0.003"), trading_cost_budget=Decimal("0.001"),
        net_snapshot_return=Decimal("0.002"), snapshot_annualized=Decimal("0.73"),
        scenario_horizon_hours=Decimal(24), mark_divergence=Decimal(0), ticker_time_skew_ms=0,
        long_ticker_age_ms=0, short_ticker_age_ms=0, funding_times_aligned=True,
        execution_status="EXECUTABLE_BOOK_VERIFIED", target_notional=Decimal(100),
        executable_quantity=Decimal("0.999"),
    )


def report(**overrides):
    books = [
        OrderBook(LONG, ((Decimal("99.9"), Decimal(2)),), ((Decimal("100.01"), Decimal(2)),), NOW),
        OrderBook(SHORT, ((Decimal("100.02"), Decimal(2)),), ((Decimal("100.1"), Decimal(2)),), NOW),
    ]
    rules = [
        SymbolRule(symbol, symbol.split("_")[0], "FUTURE", "live", Decimal("0.001"), Decimal(5), Decimal("0.001"), Decimal("0.1"))
        for symbol in (LONG, SHORT)
    ]
    account = AccountState(Decimal(1000), Decimal(1000), Decimal("2"), Decimal("3"), "SINGLE", "CROSS_EXCHANGE", "ALL", NOW - 100)
    risks = [RiskLimit(symbol, (RiskTier(Decimal(0), Decimal(10000), Decimal(20), Decimal("0.005")),)) for symbol in (LONG, SHORT)]
    params = dict(
        opportunity=opportunity(), books=books, rules=rules, account=account, positions=[], open_orders=[],
        risk_limits=risks, max_target_notional=Decimal(500), min_initial_margin_rate=Decimal("1.5"),
        min_maintenance_margin_rate=Decimal("1.5"), limit_slippage_bps=Decimal(5),
        max_account_age_ms=5000, now_ms=NOW,
    )
    params.update(overrides)
    return build_preflight_report(**params)


class PreflightTests(unittest.TestCase):
    def test_approved_report_builds_two_protected_fok_orders(self):
        value = report()
        self.assertTrue(value.approved)
        self.assertEqual([item.position_side for item in value.orders], ["NONE", "NONE"])
        self.assertEqual(value.orders[0].price, Decimal("100.1"))
        self.assertEqual(value.orders[1].price, Decimal("99.9"))

    def test_unknown_mode_stale_account_and_existing_position_fail_closed(self):
        from crossex_arb.models import PositionState

        account = AccountState(Decimal(1000), Decimal(1000), Decimal(2), Decimal(2), "UNKNOWN", "UNKNOWN", "ALL", NOW - 6000)
        value = report(account=account, positions=[PositionState(LONG, "NONE", Decimal(1), Decimal(100))])
        self.assertFalse(value.approved)
        self.assertEqual(value.orders, ())
        self.assertGreaterEqual(len(value.blockers), 4)


if __name__ == "__main__":
    unittest.main()
