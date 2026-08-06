from __future__ import annotations

import hashlib
import hmac
import json
import time
from decimal import Decimal
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from crossex_arb.models import FeeRate, FundingInfo, SymbolRule, Ticker


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
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise GateAPIError(None, "INVALID_RESPONSE", "响应不是有效的 UTF-8 JSON") from exc

    def list_symbols(self, symbols: list[str] | None = None) -> list[SymbolRule]:
        params = [("symbols", ",".join(symbols))] if symbols else None
        rows = self._request("GET", "/crossex/rule/symbols", params=params, authenticated=False)
        return [
            SymbolRule(
                symbol=row["symbol"], exchange=row["exchange_type"], business=row["business_type"],
                state=row["state"], min_size=_decimal(row.get("min_size")),
                min_notional=_decimal(row.get("min_notional")), lot_size=_decimal(row.get("lot_size")),
            )
            for row in rows
        ]

    def funding_info(self, symbols: list[str] | None = None) -> list[FundingInfo]:
        params = [("symbols", ",".join(symbols))] if symbols else None
        rows = self._request("GET", "/crossex/market/funding_info", params=params)
        return [FundingInfo(row["symbol"], Decimal(row["funding_rate"]), int(row["funding_time"]), int(row["funding_interval"])) for row in rows]

    def tickers(self, symbols: list[str] | None = None) -> list[Ticker]:
        params = [("symbols", ",".join(symbols))] if symbols else None
        rows = self._request("GET", "/crossex/market/tickers", params=params)
        return [Ticker(row["symbol"], _decimal(row.get("last_price")), _decimal(row.get("mark_price")), int(row["timestamp"])) for row in rows]

    def fees(self) -> dict[str, FeeRate]:
        rows = self._request("GET", "/crossex/fee")
        result: dict[str, FeeRate] = {}
        for row in rows:
            special = {item["symbol"]: Decimal(item["taker_fee_rate"]) for item in row.get("special_fee_list", []) if item.get("taker_fee_rate") not in (None, "")}
            result[row["exchange_type"]] = FeeRate(row["exchange_type"], Decimal(row["future_taker_fee"]), special)
        return result

    def account(self) -> Any:
        return self._request("GET", "/crossex/accounts")
