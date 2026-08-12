from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from crossex_arb.models import OrderBook
from crossex_arb.strategy import split_symbol


class MarketDepthError(RuntimeError):
    """单个底层交易所的盘口无法安全转换成 CrossEx 基础币数量。"""


SUPPORTED_VENUES = frozenset({"GATE", "BINANCE", "OKX", "BYBIT"})


def _hub_json(url: str, timeout: float) -> dict[str, Any]:
    payload = _json_get(url, timeout)
    if not isinstance(payload, dict):
        raise MarketDepthError("执行行情服务响应格式错误")
    return payload


def _hub_book(value: object, expected_symbol: str) -> OrderBook:
    if not isinstance(value, dict) or value.get("synchronized") is not True:
        raise MarketDepthError(f"{expected_symbol} 尚未通过实时盘口同步认证")
    venue, _, base, quote = split_symbol(expected_symbol)
    if value.get("venue") != venue or value.get("base") != base or value.get("quote") != quote:
        raise MarketDepthError(f"{expected_symbol} 与执行行情响应不一致")
    try:
        timestamp_ms = int(datetime.fromisoformat(str(value["exchangeTimestamp"]).replace("Z", "+00:00")).timestamp() * 1000)
    except (KeyError, TypeError, ValueError) as exc:
        raise MarketDepthError(f"{expected_symbol} 执行行情时间戳无效") from exc
    return _validated_book(
        expected_symbol,
        _levels(value.get("bids"), f"{expected_symbol} bids"),
        _levels(value.get("asks"), f"{expected_symbol} asks"),
        timestamp_ms,
        "execution_market_hub_live_synchronized",
    )


def fetch_live_pair(
    service_url: str, long_symbol: str, short_symbol: str, timeout: float
) -> tuple[OrderBook, OrderBook]:
    """从本机执行行情 Hub 原子读取两腿；质量、方向或时间不同步时直接拒绝。"""
    long_venue, long_business, long_base, long_quote = split_symbol(long_symbol)
    short_venue, short_business, short_base, short_quote = split_symbol(short_symbol)
    if (
        long_business != "FUTURE" or short_business != "FUTURE"
        or long_base != short_base or long_quote != short_quote or long_quote != "USDT"
    ):
        raise MarketDepthError("实时执行行情只支持同币种 USDT 永续配对")
    if long_venue not in SUPPORTED_VENUES or short_venue not in SUPPORTED_VENUES:
        raise MarketDepthError("实时执行行情暂不支持该交易所")
    root = service_url.rstrip("/")
    query = urlencode({"longVenue": long_venue, "shortVenue": short_venue})
    payload = _hub_json(f"{root}/api/execution-market/pairs/{long_base}?{query}", timeout)
    if payload.get("quality") != "LIVE_SYNCHRONIZED":
        reasons = payload.get("reasons")
        detail = ",".join(str(item) for item in reasons) if isinstance(reasons, list) else "unknown"
        raise MarketDepthError(f"两腿未通过 LIVE_SYNCHRONIZED 认证: {detail}")
    return _hub_book(payload.get("longBook"), long_symbol), _hub_book(payload.get("shortBook"), short_symbol)


def _decimal(value: object, field: str, *, allow_zero: bool = False) -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise MarketDepthError(f"{field} 不是有效数字") from exc
    if not parsed.is_finite() or parsed < 0 or (not allow_zero and parsed == 0):
        raise MarketDepthError(f"{field} 必须是{'非负' if allow_zero else '正'}数")
    return parsed


def _json_get(url: str, timeout: float) -> Any:
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "CrossQuant/0.3"})
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except HTTPError as exc:
        raise MarketDepthError(f"HTTP {exc.code}") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise MarketDepthError(f"网络错误: {exc}") from exc
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MarketDepthError("响应不是有效 UTF-8 JSON") from exc


def _levels(value: object, field: str, quantity_multiplier: Decimal = Decimal(1)) -> tuple[tuple[Decimal, Decimal], ...]:
    if not isinstance(value, list):
        raise MarketDepthError(f"{field} 不是数组")
    rows: list[tuple[Decimal, Decimal]] = []
    for index, item in enumerate(value):
        if isinstance(item, dict) and "p" in item and "s" in item:
            raw_price, raw_quantity = item["p"], item["s"]
        elif isinstance(item, list) and len(item) >= 2:
            raw_price, raw_quantity = item[0], item[1]
        else:
            raise MarketDepthError(f"{field}[{index}] 格式错误")
        price = _decimal(raw_price, f"{field}[{index}].price")
        quantity = _decimal(raw_quantity, f"{field}[{index}].quantity", allow_zero=True) * quantity_multiplier
        if quantity > 0:
            rows.append((price, quantity))
    return tuple(rows)


def _validated_book(
    symbol: str,
    bids: tuple[tuple[Decimal, Decimal], ...],
    asks: tuple[tuple[Decimal, Decimal], ...],
    timestamp_ms: int,
    source: str,
) -> OrderBook:
    bids = tuple(sorted(bids, key=lambda item: item[0], reverse=True))
    asks = tuple(sorted(asks, key=lambda item: item[0]))
    if timestamp_ms <= 0:
        raise MarketDepthError("盘口时间戳无效")
    if not bids or not asks:
        raise MarketDepthError("盘口缺少买盘或卖盘")
    if bids[0][0] >= asks[0][0]:
        raise MarketDepthError("盘口买卖盘交叉")
    return OrderBook(symbol, bids, asks, timestamp_ms, source)


def _gate_book(symbol: str, base: str, quote: str, timeout: float) -> OrderBook:
    if quote != "USDT":
        raise MarketDepthError("Gate 深度适配器目前只支持 USDT 永续")
    contract = f"{base}_{quote}"
    root = "https://api.gateio.ws/api/v4/futures/usdt"
    book = _json_get(f"{root}/order_book?{urlencode({'contract': contract, 'limit': 100, 'with_id': 'true'})}", timeout)
    details = _json_get(f"{root}/contracts/{contract}", timeout)
    if not isinstance(book, dict) or not isinstance(details, dict):
        raise MarketDepthError("Gate 深度或合约规则格式错误")
    multiplier = _decimal(details.get("quanto_multiplier"), "Gate quanto_multiplier")
    timestamp = book.get("current")
    if not isinstance(timestamp, (int, float)):
        timestamp_ms = int(time.time() * 1000)
    else:
        timestamp_ms = int(timestamp * 1000 if timestamp < 10_000_000_000 else timestamp)
    return _validated_book(
        symbol,
        _levels(book.get("bids"), "Gate bids", multiplier),
        _levels(book.get("asks"), "Gate asks", multiplier),
        timestamp_ms,
        "gate_futures_public_rest",
    )


def _binance_book(symbol: str, base: str, quote: str, timeout: float) -> OrderBook:
    if quote not in {"USDT", "USDC"}:
        raise MarketDepthError("Binance 深度适配器只支持 U 本位永续")
    venue_symbol = f"{base}{quote}"
    payload = _json_get(
        f"https://fapi.binance.com/fapi/v1/depth?{urlencode({'symbol': venue_symbol, 'limit': 100})}", timeout
    )
    if not isinstance(payload, dict):
        raise MarketDepthError("Binance 深度格式错误")
    timestamp_ms = payload.get("E", payload.get("T", int(time.time() * 1000)))
    if not isinstance(timestamp_ms, int):
        raise MarketDepthError("Binance 盘口时间戳无效")
    return _validated_book(
        symbol, _levels(payload.get("bids"), "Binance bids"), _levels(payload.get("asks"), "Binance asks"),
        timestamp_ms, "binance_futures_public_rest",
    )


def _okx_book(symbol: str, base: str, quote: str, timeout: float) -> OrderBook:
    if quote not in {"USDT", "USDC"}:
        raise MarketDepthError("OKX 深度适配器只支持 U 本位永续")
    instrument = f"{base}-{quote}-SWAP"
    root = "https://www.okx.com/api/v5"
    book = _json_get(f"{root}/market/books?{urlencode({'instId': instrument, 'sz': 100})}", timeout)
    details = _json_get(f"{root}/public/instruments?{urlencode({'instType': 'SWAP', 'instId': instrument})}", timeout)
    if not isinstance(book, dict) or book.get("code") != "0" or not isinstance(book.get("data"), list) or not book["data"]:
        raise MarketDepthError("OKX 深度格式错误")
    if not isinstance(details, dict) or details.get("code") != "0" or not isinstance(details.get("data"), list) or not details["data"]:
        raise MarketDepthError("OKX 合约规则格式错误")
    instrument_row = details["data"][0]
    if not isinstance(instrument_row, dict) or instrument_row.get("ctValCcy") != base:
        raise MarketDepthError("OKX ctValCcy 与基础币不一致")
    multiplier = _decimal(instrument_row.get("ctVal"), "OKX ctVal")
    row = book["data"][0]
    if not isinstance(row, dict):
        raise MarketDepthError("OKX 深度行格式错误")
    try:
        timestamp_ms = int(str(row["ts"]))
    except (KeyError, ValueError) as exc:
        raise MarketDepthError("OKX 盘口时间戳无效") from exc
    return _validated_book(
        symbol, _levels(row.get("bids"), "OKX bids", multiplier), _levels(row.get("asks"), "OKX asks", multiplier),
        timestamp_ms, "okx_swap_public_rest",
    )


def _bybit_book(symbol: str, base: str, quote: str, timeout: float) -> OrderBook:
    if quote not in {"USDT", "USDC"}:
        raise MarketDepthError("Bybit 深度适配器只支持线性永续")
    venue_symbol = f"{base}{quote}"
    payload = _json_get(
        f"https://api.bybit.com/v5/market/orderbook?{urlencode({'category': 'linear', 'symbol': venue_symbol, 'limit': 200})}",
        timeout,
    )
    if not isinstance(payload, dict) or payload.get("retCode") != 0 or not isinstance(payload.get("result"), dict):
        raise MarketDepthError("Bybit 深度格式错误")
    row = payload["result"]
    try:
        timestamp_ms = int(str(payload.get("time", row.get("ts"))))
    except (TypeError, ValueError) as exc:
        raise MarketDepthError("Bybit 盘口时间戳无效") from exc
    return _validated_book(
        symbol, _levels(row.get("b"), "Bybit bids"), _levels(row.get("a"), "Bybit asks"),
        timestamp_ms, "bybit_linear_public_rest",
    )


def fetch_order_book(symbol: str, timeout: float) -> OrderBook:
    """读取一个 CrossEx 交易对对应的底层官方深度，并统一成基础币数量。"""
    venue, business, base, quote = split_symbol(symbol)
    if business != "FUTURE":
        raise MarketDepthError("只支持永续合约深度")
    adapters = {"GATE": _gate_book, "BINANCE": _binance_book, "OKX": _okx_book, "BYBIT": _bybit_book}
    adapter = adapters.get(venue)
    if adapter is None:
        raise MarketDepthError(f"暂不支持 {venue} 的权威深度单位换算")
    return adapter(symbol, base, quote, timeout)


def collect_order_books(
    symbols: list[str], timeout_seconds: float, *, workers: int = 8
) -> tuple[list[OrderBook], dict[str, str]]:
    """并发采集盘口；单所失败被隔离并返回错误，策略层会拒绝对应候选。"""
    wanted = list(dict.fromkeys(symbols))
    if timeout_seconds <= 0 or workers <= 0:
        raise ValueError("盘口超时和并发数必须大于 0")
    books: list[OrderBook] = []
    errors: dict[str, str] = {}
    supported: list[str] = []
    for symbol in wanted:
        venue = split_symbol(symbol)[0]
        if venue not in SUPPORTED_VENUES:
            errors[symbol] = f"暂不支持 {venue} 的权威深度单位换算"
        else:
            supported.append(symbol)
    with ThreadPoolExecutor(max_workers=min(workers, max(1, len(supported)))) as executor:
        futures = {executor.submit(fetch_order_book, symbol, timeout_seconds): symbol for symbol in supported}
        for future in as_completed(futures):
            symbol = futures[future]
            try:
                books.append(future.result())
            except (MarketDepthError, ValueError) as exc:
                errors[symbol] = str(exc)
            except Exception as exc:  # 防止单个适配器异常拖垮全市场扫描。
                errors[symbol] = f"未预期的盘口错误: {type(exc).__name__}: {exc}"
    books.sort(key=lambda item: item.symbol)
    return books, errors
