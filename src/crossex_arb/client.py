from __future__ import annotations

import hashlib
import hmac
import json
import time
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from crossex_arb.models import (
    AccountState,
    FeeRate,
    FundingInfo,
    OpenOrderState,
    PositionState,
    RiskLimit,
    RiskTier,
    SymbolRule,
    Ticker,
)


class GateAPIError(RuntimeError):
    def __init__(self, status: int | None, label: str, message: str) -> None:
        super().__init__(f"Gate API 错误 {status or '-'} [{label}]: {message}")
        self.status = status
        self.label = label
        self.message = message


def build_signature(
    secret: str,
    method: str,
    path: str,
    query_string: str = "",
    body: bytes = b"",
    timestamp: str | None = None,
) -> tuple[str, str]:
    """生成 Gate API v4 签名；path 必须包含 /api/v4 前缀。"""
    timestamp = timestamp or str(int(time.time()))
    payload_hash = hashlib.sha512(body).hexdigest()
    sign_text = "\n".join((method.upper(), path, query_string, payload_hash, timestamp))
    signature = hmac.new(secret.encode("utf-8"), sign_text.encode("utf-8"), hashlib.sha512).hexdigest()
    return timestamp, signature


def _decimal(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    return Decimal(str(value))


def _response_rows(value: Any, endpoint: str) -> list[dict[str, Any]]:
    """入口统一验证 API 结构，避免字段异常在策略层被当成有效数据。"""
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise GateAPIError(None, "INVALID_RESPONSE", f"{endpoint} 应返回对象数组")
    return value


def encode_query(params: list[tuple[str, str]] | None) -> str:
    """Gate 要求签名字符串和 URL 使用同一查询串，symbols 中的逗号需要保持原样。"""
    return urlencode(params or [], doseq=True, safe=",")


class GateCrossExClient:
    prefix = "/api/v4"

    def __init__(self, base_url: str, api_key: str = "", api_secret: str = "", timeout: float = 10.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.api_secret = api_secret
        self.timeout = timeout

    def _request(
        self,
        method: str,
        endpoint: str,
        params: list[tuple[str, str]] | None = None,
        payload: dict[str, Any] | None = None,
        authenticated: bool = True,
    ) -> Any:
        query = encode_query(params)
        path = self.prefix + endpoint
        body = b"" if payload is None else json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        headers = {"Accept": "application/json", "Content-Type": "application/json; charset=utf-8"}
        if authenticated:
            if not self.api_key or not self.api_secret:
                raise GateAPIError(None, "MISSING_CREDENTIALS", "请在 .env 填写 GATE_API_KEY 和 GATE_API_SECRET")
            timestamp, signature = build_signature(self.api_secret, method, path, query, body)
            headers.update({"KEY": self.api_key, "Timestamp": timestamp, "SIGN": signature})
        url = self.base_url + path + ("?" + query if query else "")
        request = Request(url, data=body if payload is not None else None, headers=headers, method=method.upper())
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except HTTPError as exc:
            raw = exc.read()
            try:
                error = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                error = {"label": "HTTP_ERROR", "message": raw.decode("utf-8", errors="replace")}
            raise GateAPIError(exc.code, str(error.get("label", "UNKNOWN")), str(error.get("message", error.get("detail", "")))) from exc
        except URLError as exc:
            raise GateAPIError(None, "NETWORK_ERROR", str(exc.reason)) from exc
        except (TimeoutError, OSError) as exc:
            raise GateAPIError(None, "NETWORK_ERROR", str(exc)) from exc
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise GateAPIError(None, "INVALID_RESPONSE", "响应不是有效的 UTF-8 JSON") from exc

    def list_symbols(self, symbols: list[str] | None = None) -> list[SymbolRule]:
        params = [("symbols", ",".join(symbols))] if symbols else None
        rows = _response_rows(self._request("GET", "/crossex/rule/symbols", params=params, authenticated=False), "symbols")
        try:
            return [
                SymbolRule(
                    symbol=str(row["symbol"]), exchange=str(row["exchange_type"]), business=str(row["business_type"]),
                    state=str(row["state"]), min_size=_decimal(row.get("min_size")),
                    min_notional=_decimal(row.get("min_notional")), lot_size=_decimal(row.get("lot_size")),
                    tick_size=_decimal(row.get("tick_size")), max_market_size=_decimal(row.get("max_market_size")),
                    max_limit_size=_decimal(row.get("max_limit_size")),
                )
                for row in rows
            ]
        except (KeyError, TypeError, ValueError, InvalidOperation) as exc:
            raise GateAPIError(None, "INVALID_RESPONSE", f"symbols 字段异常: {exc}") from exc

    def funding_info(self, symbols: list[str] | None = None) -> list[FundingInfo]:
        params = [("symbols", ",".join(symbols))] if symbols else None
        rows = _response_rows(self._request("GET", "/crossex/market/funding_info", params=params), "funding_info")
        try:
            result = [FundingInfo(str(row["symbol"]), Decimal(str(row["funding_rate"])), int(row["funding_time"]), int(row["funding_interval"])) for row in rows]
        except (KeyError, TypeError, ValueError, InvalidOperation) as exc:
            raise GateAPIError(None, "INVALID_RESPONSE", f"funding_info 字段异常: {exc}") from exc
        if any(item.interval_seconds <= 0 or item.next_time_ms <= 0 for item in result):
            raise GateAPIError(None, "INVALID_RESPONSE", "funding_info 包含无效结算时间或周期")
        return result

    def tickers(self, symbols: list[str] | None = None) -> list[Ticker]:
        params = [("symbols", ",".join(symbols))] if symbols else None
        rows = _response_rows(self._request("GET", "/crossex/market/tickers", params=params), "tickers")
        try:
            return [Ticker(str(row["symbol"]), _decimal(row.get("last_price")), _decimal(row.get("mark_price")), int(row["timestamp"])) for row in rows]
        except (KeyError, TypeError, ValueError, InvalidOperation) as exc:
            raise GateAPIError(None, "INVALID_RESPONSE", f"tickers 字段异常: {exc}") from exc

    def fees(self) -> dict[str, FeeRate]:
        rows = _response_rows(self._request("GET", "/crossex/fee"), "fee")
        result: dict[str, FeeRate] = {}
        try:
            for row in rows:
                special_rows = row.get("special_fee_list", [])
                if not isinstance(special_rows, list) or any(not isinstance(item, dict) for item in special_rows):
                    raise TypeError("special_fee_list 不是对象数组")
                special = {str(item["symbol"]): Decimal(str(item["taker_fee_rate"])) for item in special_rows if item.get("taker_fee_rate") not in (None, "")}
                exchange = str(row["exchange_type"])
                if exchange in result:
                    raise ValueError(f"重复交易所 {exchange}")
                result[exchange] = FeeRate(exchange, Decimal(str(row["future_taker_fee"])), special)
        except (KeyError, TypeError, ValueError, InvalidOperation) as exc:
            raise GateAPIError(None, "INVALID_RESPONSE", f"fee 字段异常: {exc}") from exc
        return result

    def account(self) -> Any:
        return self._request("GET", "/crossex/accounts")

    def account_state(self) -> AccountState:
        row = self.account()
        if not isinstance(row, dict):
            raise GateAPIError(None, "INVALID_RESPONSE", "accounts 应返回对象")
        try:
            return AccountState(
                available_margin=Decimal(str(row["available_margin"])),
                margin_balance=Decimal(str(row["margin_balance"])),
                initial_margin_rate=Decimal(str(row["initial_margin_rate"])),
                maintenance_margin_rate=Decimal(str(row["maintenance_margin_rate"])),
                position_mode=str(row["position_mode"]), account_mode=str(row["account_mode"]),
                exchange_type=str(row["exchange_type"]), update_time_ms=int(row["update_time"]),
            )
        except (KeyError, TypeError, ValueError, InvalidOperation) as exc:
            raise GateAPIError(None, "INVALID_RESPONSE", f"accounts 字段异常: {exc}") from exc

    def positions(self) -> list[PositionState]:
        rows = _response_rows(self._request("GET", "/crossex/positions"), "positions")
        try:
            return [
                PositionState(
                    str(row["symbol"]), str(row["position_side"]),
                    Decimal(str(row["position_qty"])), Decimal(str(row["position_value"])),
                )
                for row in rows
            ]
        except (KeyError, TypeError, ValueError, InvalidOperation) as exc:
            raise GateAPIError(None, "INVALID_RESPONSE", f"positions 字段异常: {exc}") from exc

    def open_orders(self) -> list[OpenOrderState]:
        rows = _response_rows(self._request("GET", "/crossex/open_orders"), "open_orders")
        try:
            return [
                OpenOrderState(
                    str(row["order_id"]), str(row["symbol"]), str(row["state"]), str(row["side"]),
                    Decimal(str(row["qty"])),
                )
                for row in rows
            ]
        except (KeyError, TypeError, ValueError, InvalidOperation) as exc:
            raise GateAPIError(None, "INVALID_RESPONSE", f"open_orders 字段异常: {exc}") from exc

    def risk_limits(self, symbols: list[str]) -> list[RiskLimit]:
        params = [("symbols", ",".join(symbols))]
        rows = _response_rows(
            self._request("GET", "/crossex/rule/risk_limits", params=params, authenticated=False), "risk_limits"
        )
        try:
            result: list[RiskLimit] = []
            for row in rows:
                raw_tiers = row["tiers"]
                if not isinstance(raw_tiers, list):
                    raise TypeError("tiers 不是数组")
                tiers = tuple(
                    RiskTier(
                        Decimal(str(tier["min_risk_limit_value"])), Decimal(str(tier["max_risk_limit_value"])),
                        Decimal(str(tier["leverage_max"])), Decimal(str(tier["maintenance_rate"])),
                    )
                    for tier in raw_tiers
                    if isinstance(tier, dict)
                )
                if len(tiers) != len(raw_tiers):
                    raise TypeError("tiers 包含非对象")
                result.append(RiskLimit(str(row["symbol"]), tiers))
            return result
        except (KeyError, TypeError, ValueError, InvalidOperation) as exc:
            raise GateAPIError(None, "INVALID_RESPONSE", f"risk_limits 字段异常: {exc}") from exc
