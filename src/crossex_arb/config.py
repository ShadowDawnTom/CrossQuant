from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def load_dotenv(path: Path = Path(".env")) -> None:
    """按 UTF-8 读取简单的 KEY=VALUE 配置，已有环境变量优先。"""
    if not path.is_file():
        return
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError(f"{path}:{line_number} 不是有效的 KEY=VALUE")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)


def _as_bool(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    api_key: str = ""
    api_secret: str = ""
    base_url: str = "https://api.gateio.ws"
    live_trading: bool = False
    scenario_horizon_hours: float = 24.0
    min_snapshot_annualized: float = 0.10
    max_mark_price_divergence: float = 0.003
    max_ticker_age_ms: int = 10_000
    max_ticker_skew_ms: int = 2_000
    slippage_bps_per_fill: float = 2.0
    default_taker_fee: float = 0.0005
    timeout_seconds: float = 10.0

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        settings = cls(
            api_key=os.getenv("GATE_API_KEY", "").strip(),
            api_secret=os.getenv("GATE_API_SECRET", "").strip(),
            base_url=os.getenv("GATE_BASE_URL", "https://api.gateio.ws").rstrip("/"),
            live_trading=_as_bool(os.getenv("ENABLE_LIVE_TRADING", "false")),
            scenario_horizon_hours=float(os.getenv("ARB_SCENARIO_HORIZON_HOURS", os.getenv("ARB_HOLDING_HOURS", "24"))),
            min_snapshot_annualized=float(os.getenv("ARB_MIN_SNAPSHOT_ANNUALIZED", os.getenv("ARB_MIN_NET_ANNUALIZED", "0.10"))),
            max_mark_price_divergence=float(os.getenv("ARB_MAX_MARK_PRICE_DIVERGENCE", "0.003")),
            max_ticker_age_ms=int(os.getenv("ARB_MAX_TICKER_AGE_MS", "10000")),
            max_ticker_skew_ms=int(os.getenv("ARB_MAX_TICKER_SKEW_MS", "2000")),
            slippage_bps_per_fill=float(os.getenv("ARB_SLIPPAGE_BPS_PER_FILL", "2")),
            default_taker_fee=float(os.getenv("ARB_DEFAULT_TAKER_FEE", "0.0005")),
        )
        if settings.scenario_horizon_hours <= 0:
            raise ValueError("ARB_SCENARIO_HORIZON_HOURS 必须大于 0")
        if settings.max_ticker_age_ms < 0 or settings.max_ticker_skew_ms < 0:
            raise ValueError("行情时间阈值不能为负数")
        if settings.slippage_bps_per_fill < 0 or settings.default_taker_fee < 0:
            raise ValueError("滑点和手续费不能为负数")
        return settings
