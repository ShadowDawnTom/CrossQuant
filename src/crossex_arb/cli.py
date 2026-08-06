from __future__ import annotations

import argparse
import json
import sys
from decimal import Decimal

from crossex_arb.client import GateAPIError, GateCrossExClient
from crossex_arb.config import Settings
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


def _scan(client: GateCrossExClient, settings: Settings, assets_text: str, quote: str, as_json: bool) -> int:
    assets = {item.strip().upper() for item in assets_text.split(",") if item.strip()}
    rules = [item for item in client.list_symbols() if item.business == "FUTURE"]
    wanted = [item.symbol for item in rules if split_symbol(item.symbol)[2] in assets and split_symbol(item.symbol)[3] == quote.upper()]
    if not wanted:
        print("没有找到符合条件的 CrossEx 永续交易对。", file=sys.stderr)
        return 2
    funding = client.funding_info(wanted)
    tickers = client.tickers(wanted)
    fees = client.fees()
    rows = find_opportunities(
        funding=funding, tickers=tickers, fees=fees, rules=rules,
        holding_hours=Decimal(str(settings.holding_hours)),
        slippage_bps_per_fill=Decimal(str(settings.slippage_bps_per_fill)),
        default_taker_fee=Decimal(str(settings.default_taker_fee)),
        max_mark_divergence=Decimal(str(settings.max_mark_price_divergence)),
        assets=assets, quote=quote.upper(),
    )
    threshold = Decimal(str(settings.min_net_annualized))
    rows = [item for item in rows if item.net_annualized >= threshold]
    if as_json:
        print(json.dumps([item.to_dict() for item in rows], ensure_ascii=False, indent=2))
        return 0
    if not rows:
        print("当前没有达到阈值的候选机会。")
        return 0
    print("说明：LONG=做多低费率，SHORT=做空高费率；结果未使用盘口深度，不是下单指令。")
    for item in rows:
        aligned = "是" if item.funding_times_aligned else "否"
        divergence = "未知" if item.mark_divergence is None else f"{item.mark_divergence:.3%}"
        print(
            f"\n{item.asset}/{item.quote}  净年化={item.net_annualized:.2%}  持有期净收益={item.net_return:.4%}\n"
            f"  LONG  {item.long_symbol}  funding={item.long_rate:.6%}\n"
            f"  SHORT {item.short_symbol}  funding={item.short_rate:.6%}\n"
            f"  成本={item.trading_cost:.4%}  标记价偏离={divergence}  结算时间对齐={aligned}"
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
        if args.command == "scan":
            if not settings.api_key or not settings.api_secret:
                raise GateAPIError(None, "MISSING_CREDENTIALS", "请在 .env 填写 GATE_API_KEY 和 GATE_API_SECRET")
            return _scan(client, settings, args.assets, args.quote, args.json)
    except (GateAPIError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 1
