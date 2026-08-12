from __future__ import annotations

import argparse
import json
import sys
from decimal import Decimal
from pathlib import Path

from crossex_arb.client import GateAPIError, GateCrossExClient
from crossex_arb.config import Settings
from crossex_arb.history import append_market_snapshot
from crossex_arb.market_depth import collect_order_books
from crossex_arb.models import ScanResult
from crossex_arb.shadow import ShadowExecutionEngine, ShadowStore, result_to_dict
from crossex_arb.strategy import find_opportunities, split_symbol


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Gate CrossEx 资金费率套利监控器（只读）")
    sub = parser.add_subparsers(dest="command", required=True)
    symbols = sub.add_parser("symbols", help="查询 CrossEx 交易对规则")
    symbols.add_argument("--base", help="只显示指定基础币，例如 BTC")
    symbols.add_argument("--quote", default="USDT", help="计价币，默认 USDT")
    sub.add_parser("account", help="验证 API Key 并查询账户资产")
    scan = sub.add_parser("scan", help="扫描跨所永续资金费率机会")
    scan.add_argument("--assets", default="BTC,ETH,SOL", help="逗号分隔的基础币")
    scan.add_argument("--quote", default="USDT", help="计价币，默认 USDT")
    scan.add_argument("--json", action="store_true", help="输出 JSON")
    scan.add_argument("--with-order-book", action="store_true", help="读取底层交易所官方深度并验证目标金额可执行收益")
    scan.add_argument("--target-notional", type=Decimal, help="每条腿的目标名义金额，默认读取 ARB_TARGET_NOTIONAL")
    scan.add_argument("--snapshot-log", type=Path, help="将原始费率、Ticker 和手续费追加为 UTF-8 JSONL")
    scan.add_argument("--shadow-db", type=Path, help="使用下一份盘口影子开仓排名第一的候选，并写入 SQLite")
    scan.add_argument("--shadow-key", help="影子开仓幂等键；使用 --shadow-db 时必填")
    shadow_list = sub.add_parser("shadow-list", help="查看本地影子交易账本")
    shadow_list.add_argument("--db", type=Path, default=Path("data/shadow.db"), help="SQLite 路径")
    shadow_list.add_argument("--limit", type=int, default=50)
    return parser


def _client(settings: Settings) -> GateCrossExClient:
    return GateCrossExClient(settings.base_url, settings.api_key, settings.api_secret, settings.timeout_seconds)


def _print_symbols(client: GateCrossExClient, base: str | None, quote: str) -> int:
    rows = client.list_symbols()
    for row in rows:
        _, _, row_base, row_quote = split_symbol(row.symbol)
        if row.business == "FUTURE" and row_quote == quote.upper() and (not base or row_base == base.upper()):
            print(f"{row.symbol:<38} state={row.state:<8} min={row.min_size} lot={row.lot_size} notional={row.min_notional}")
    return 0


def _scan(
    client: GateCrossExClient,
    settings: Settings,
    assets_text: str,
    quote: str,
    as_json: bool,
    snapshot_log: Path | None,
    with_order_book: bool,
    target_notional: Decimal | None,
    shadow_db: Path | None,
    shadow_key: str | None,
) -> int:
    if shadow_db is not None and not with_order_book:
        raise ValueError("--shadow-db 必须和 --with-order-book 一起使用")
    if shadow_db is not None and not shadow_key:
        raise ValueError("--shadow-db 必须提供非空 --shadow-key，防止重复影子开仓")
    assets = {item.strip().upper() for item in assets_text.split(",") if item.strip()}
    rules = [item for item in client.list_symbols() if item.business == "FUTURE"]
    wanted = [item.symbol for item in rules if split_symbol(item.symbol)[2] in assets and split_symbol(item.symbol)[3] == quote.upper()]
    if not wanted:
        print("没有找到符合条件的 CrossEx 永续交易对。", file=sys.stderr)
        return 2
    funding = client.funding_info(wanted)
    tickers = client.tickers(wanted)
    fees = client.fees()
    books = None
    book_errors: dict[str, str] = {}
    requested_notional = target_notional or Decimal(str(settings.target_notional))
    if with_order_book:
        books, book_errors = collect_order_books(
            [item.symbol for item in funding], settings.order_book_timeout_seconds
        )
    if snapshot_log is not None:
        append_market_snapshot(snapshot_log, funding, tickers, fees, order_books=books)
    result = find_opportunities(
        funding=funding, tickers=tickers, fees=fees, rules=rules,
        scenario_horizon_hours=Decimal(str(settings.scenario_horizon_hours)),
        slippage_bps_per_fill=Decimal(str(settings.slippage_bps_per_fill)),
        default_taker_fee=Decimal(str(settings.default_taker_fee)),
        max_mark_divergence=Decimal(str(settings.max_mark_price_divergence)),
        assets=assets, quote=quote.upper(),
        order_books=books,
        target_notional=requested_notional if with_order_book else None,
        max_order_book_age_ms=settings.max_order_book_age_ms,
        max_order_book_skew_ms=settings.max_order_book_skew_ms,
        max_ticker_age_ms=settings.max_ticker_age_ms,
        max_ticker_skew_ms=settings.max_ticker_skew_ms,
    )
    if book_errors:
        from crossex_arb.models import CandidateRejection

        result.rejections.extend(
            CandidateRejection(split_symbol(symbol)[2], split_symbol(symbol)[3], (symbol,), "ORDER_BOOK_SOURCE_ERROR", detail)
            for symbol, detail in sorted(book_errors.items())
        )
    threshold = Decimal(str(settings.min_snapshot_annualized))
    result = ScanResult(
        [
            item for item in result.opportunities
            if (
                item.executable_snapshot_annualized
                if with_order_book
                else item.snapshot_annualized
            ) is not None
            and (
                item.executable_snapshot_annualized
                if with_order_book
                else item.snapshot_annualized
            ) >= threshold
        ],
        result.rejections,
    )
    shadow_result = None
    if shadow_db is not None and result.opportunities:
        selected = result.opportunities[0]
        execution_books, execution_errors = collect_order_books(
            [selected.long_symbol, selected.short_symbol], settings.order_book_timeout_seconds, workers=2
        )
        if execution_errors:
            details = "; ".join(f"{symbol}: {detail}" for symbol, detail in sorted(execution_errors.items()))
            raise ValueError(f"影子执行的第二次盘口采集失败: {details}")
        with ShadowStore(shadow_db) as store:
            shadow_result = ShadowExecutionEngine(store).open(
                selected, execution_books, idempotency_key=shadow_key or ""
            )
    if as_json:
        payload = result.to_dict()
        if shadow_result is not None:
            payload["shadow_execution"] = result_to_dict(shadow_result)
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    if result.rejections:
        print(f"已拒绝 {len(result.rejections)} 个数据不完整或超出风控阈值的候选。")
    if not result.opportunities:
        print("当前没有达到阈值的快照情景候选。")
        return 0
    print("说明：下列是“当前费率在情景期保持不变”的快照外推，不是预期 APR。")
    if with_order_book:
        print("已按实时双边盘口和目标金额验证 VWAP；平仓价格仍是假设立即按当前反向盘口成交。")
    else:
        print("未使用 ask/bid、盘口深度和双腿成交模型，所有结果均不代表可执行收益。")
    for item in result.opportunities:
        aligned = "是" if item.funding_times_aligned else "否"
        print(
            f"\n{item.asset}/{item.quote}  快照情景年化={item.snapshot_annualized:.2%}  "
            f"情景期净收益={item.net_snapshot_return:.4%}\n"
            f"  LONG  {item.long_symbol}  funding={item.long_rate:.6%}  结算次数={item.long_funding_events}\n"
            f"  SHORT {item.short_symbol}  funding={item.short_rate:.6%}  结算次数={item.short_funding_events}\n"
            f"  成本预算={item.trading_cost_budget:.4%}  标记价偏离={item.mark_divergence:.3%}  "
            f"行情时差={item.ticker_time_skew_ms}ms  首次结算对齐={aligned}"
        )
        if item.execution_status == "EXECUTABLE_BOOK_VERIFIED":
            print(
                f"  可执行数量={item.executable_quantity}  LONG入场VWAP={item.long_entry_vwap}  "
                f"SHORT入场VWAP={item.short_entry_vwap}\n"
                f"  盘口净情景收益={item.executable_net_snapshot_return:.4%}  "
                f"盘口净情景年化={item.executable_snapshot_annualized:.2%}  盘口时差={item.book_time_skew_ms}ms"
            )
    if shadow_result is not None:
        print(
            f"\n影子交易 {shadow_result.trade_id}  状态={shadow_result.state}  "
            f"持仓数量={shadow_result.open_quantity}  净敞口={shadow_result.net_base_exposure}"
        )
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        settings = Settings.from_env()
        client = _client(settings)
        if args.command == "symbols":
            return _print_symbols(client, args.base, args.quote)
        if args.command == "account":
            print(json.dumps(client.account(), ensure_ascii=False, indent=2))
            return 0
        if args.command == "shadow-list":
            with ShadowStore(args.db) as store:
                print(json.dumps(store.list_trades(args.limit), ensure_ascii=False, indent=2))
            return 0
        if args.command == "scan":
            if not settings.api_key or not settings.api_secret:
                raise GateAPIError(None, "MISSING_CREDENTIALS", "请在 .env 填写 GATE_API_KEY 和 GATE_API_SECRET")
            return _scan(
                client, settings, args.assets, args.quote, args.json, args.snapshot_log,
                args.with_order_book, args.target_notional, args.shadow_db, args.shadow_key,
            )
    except (GateAPIError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 1
