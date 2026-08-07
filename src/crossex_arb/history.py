from __future__ import annotations

import json
import time
from dataclasses import asdict
from decimal import Decimal
from pathlib import Path
from typing import Any

from crossex_arb.models import FeeRate, FundingInfo, Ticker


def _json_default(value: object) -> str:
    if isinstance(value, Decimal):
        return str(value)
    raise TypeError(f"不支持序列化 {type(value).__name__}")


def append_market_snapshot(
    path: Path,
    funding: list[FundingInfo],
    tickers: list[Ticker],
    fees: dict[str, FeeRate],
    *,
    collected_at_ms: int | None = None,
) -> None:
    """以 UTF-8 JSONL 追加一次原始市场快照，便于后续重放和校验字段变化。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "collected_at_ms": int(time.time() * 1000) if collected_at_ms is None else collected_at_ms,
        "funding": [asdict(item) for item in funding],
        "tickers": [asdict(item) for item in tickers],
        "fees": {exchange: asdict(item) for exchange, item in fees.items()},
    }
    # newline 显式固定为 LF，避免重放文件在不同平台产生无意义差异。
    with path.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=_json_default))
        stream.write("\n")


def load_market_snapshots(path: Path) -> list[dict[str, Any]]:
    """严格按 UTF-8 读回 JSONL；损坏行会带行号报错，不会被静默跳过。"""
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", newline="") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_number} 不是有效 JSON") from exc
            if not isinstance(value, dict) or value.get("schema_version") != 1:
                raise ValueError(f"{path}:{line_number} 快照版本不支持")
            rows.append(value)
    return rows
