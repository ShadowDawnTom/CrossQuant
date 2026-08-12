from __future__ import annotations

import json
import sqlite3
import time
import uuid
from dataclasses import asdict, dataclass
from decimal import Decimal
from pathlib import Path

from crossex_arb.models import Opportunity, OrderBook
from crossex_arb.strategy import quote_order_book


TERMINAL_STATES = frozenset({"OPEN", "OPEN_PARTIAL", "ABORTED_FLAT", "CLOSED", "MANUAL_INTERVENTION"})


@dataclass(frozen=True)
class ShadowFill:
    leg: str
    symbol: str
    side: str
    requested_quantity: Decimal
    filled_quantity: Decimal
    average_price: Decimal | None
    quote_amount: Decimal
    status: str


@dataclass(frozen=True)
class ShadowTradeResult:
    trade_id: str
    state: str
    fills: tuple[ShadowFill, ...]
    net_base_exposure: Decimal
    open_quantity: Decimal
    gross_execution_cashflow: Decimal


class ShadowStore:
    """SQLite 影子账本；每次状态变化和成交在同一事务中落盘。"""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, timeout=10)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.execute("PRAGMA journal_mode = WAL")
        self.connection.execute("PRAGMA synchronous = FULL")
        self._migrate()

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> "ShadowStore":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _migrate(self) -> None:
        with self.connection:
            self.connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS shadow_trades (
                    trade_id TEXT PRIMARY KEY,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    state TEXT NOT NULL,
                    asset TEXT NOT NULL,
                    quote TEXT NOT NULL,
                    long_symbol TEXT NOT NULL,
                    short_symbol TEXT NOT NULL,
                    target_quantity TEXT NOT NULL,
                    opportunity_json TEXT NOT NULL,
                    net_base_exposure TEXT NOT NULL DEFAULT '0',
                    open_quantity TEXT NOT NULL DEFAULT '0',
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS shadow_fills (
                    fill_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    trade_id TEXT NOT NULL REFERENCES shadow_trades(trade_id),
                    leg TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL,
                    requested_quantity TEXT NOT NULL,
                    filled_quantity TEXT NOT NULL,
                    average_price TEXT,
                    quote_amount TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS shadow_events (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    trade_id TEXT NOT NULL REFERENCES shadow_trades(trade_id),
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_shadow_trades_state ON shadow_trades(state, updated_at_ms);
                CREATE INDEX IF NOT EXISTS idx_shadow_fills_trade ON shadow_fills(trade_id, fill_id);
                """
            )
            columns = {str(row[1]) for row in self.connection.execute("PRAGMA table_info(shadow_trades)")}
            if "open_quantity" not in columns:
                self.connection.execute(
                    "ALTER TABLE shadow_trades ADD COLUMN open_quantity TEXT NOT NULL DEFAULT '0'"
                )

    def existing(self, idempotency_key: str) -> ShadowTradeResult | None:
        row = self.connection.execute(
            "SELECT trade_id, state, net_base_exposure, open_quantity FROM shadow_trades WHERE idempotency_key = ?",
            (idempotency_key,),
        ).fetchone()
        return None if row is None else self.result(str(row["trade_id"]))

    def create(self, opportunity: Opportunity, idempotency_key: str, now_ms: int) -> str:
        if opportunity.executable_quantity is None or opportunity.executable_quantity <= 0:
            raise ValueError("影子执行要求已通过盘口校验的正数 executable_quantity")
        trade_id = uuid.uuid4().hex
        payload = json.dumps(opportunity.to_dict(), ensure_ascii=False, separators=(",", ":"))
        with self.connection:
            self.connection.execute(
                """INSERT INTO shadow_trades
                   (trade_id,idempotency_key,state,asset,quote,long_symbol,short_symbol,target_quantity,
                    opportunity_json,net_base_exposure,open_quantity,created_at_ms,updated_at_ms)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    trade_id, idempotency_key, "PLANNED", opportunity.asset, opportunity.quote,
                    opportunity.long_symbol, opportunity.short_symbol, str(opportunity.executable_quantity),
                    payload, "0", "0", now_ms, now_ms,
                ),
            )
            self._event(trade_id, "PLANNED", {"idempotency_key": idempotency_key}, now_ms)
        return trade_id

    def transition(
        self,
        trade_id: str,
        expected_state: str,
        new_state: str,
        fills: tuple[ShadowFill, ...],
        net_exposure: Decimal,
        open_quantity: Decimal,
        now_ms: int,
    ) -> None:
        with self.connection:
            cursor = self.connection.execute(
                "UPDATE shadow_trades SET state=?,net_base_exposure=?,open_quantity=?,updated_at_ms=? "
                "WHERE trade_id=? AND state=?",
                (new_state, str(net_exposure), str(open_quantity), now_ms, trade_id, expected_state),
            )
            if cursor.rowcount != 1:
                raise RuntimeError(f"{trade_id} 状态已变化，拒绝从 {expected_state} 重复推进")
            for fill in fills:
                self.connection.execute(
                    """INSERT INTO shadow_fills
                       (trade_id,leg,symbol,side,requested_quantity,filled_quantity,average_price,
                        quote_amount,status,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (
                        trade_id, fill.leg, fill.symbol, fill.side, str(fill.requested_quantity),
                        str(fill.filled_quantity), None if fill.average_price is None else str(fill.average_price),
                        str(fill.quote_amount), fill.status, now_ms,
                    ),
                )
            self._event(
                trade_id, new_state,
                {
                    "net_base_exposure": str(net_exposure), "open_quantity": str(open_quantity),
                    "fills": [fill_to_dict(item) for item in fills],
                }, now_ms,
            )

    def _event(self, trade_id: str, event_type: str, payload: dict[str, object], now_ms: int) -> None:
        self.connection.execute(
            "INSERT INTO shadow_events(trade_id,event_type,payload_json,created_at_ms) VALUES (?,?,?,?)",
            (trade_id, event_type, json.dumps(payload, ensure_ascii=False, separators=(",", ":")), now_ms),
        )

    def result(self, trade_id: str) -> ShadowTradeResult:
        trade = self.connection.execute(
            "SELECT trade_id,state,net_base_exposure,open_quantity FROM shadow_trades WHERE trade_id=?", (trade_id,)
        ).fetchone()
        if trade is None:
            raise KeyError(trade_id)
        rows = self.connection.execute(
            "SELECT leg,symbol,side,requested_quantity,filled_quantity,average_price,quote_amount,status "
            "FROM shadow_fills WHERE trade_id=? ORDER BY fill_id", (trade_id,)
        ).fetchall()
        fills = tuple(
            ShadowFill(
                str(row["leg"]), str(row["symbol"]), str(row["side"]), Decimal(str(row["requested_quantity"])),
                Decimal(str(row["filled_quantity"])),
                None if row["average_price"] is None else Decimal(str(row["average_price"])),
                Decimal(str(row["quote_amount"])), str(row["status"]),
            )
            for row in rows
        )
        return ShadowTradeResult(
            str(trade["trade_id"]), str(trade["state"]), fills, Decimal(str(trade["net_base_exposure"])),
            Decimal(str(trade["open_quantity"])),
            sum(
                (item.quote_amount if item.side == "SELL" else -item.quote_amount for item in fills),
                Decimal(0),
            ),
        )

    def list_trades(self, limit: int = 50) -> list[dict[str, object]]:
        if limit <= 0 or limit > 1000:
            raise ValueError("limit 必须在 1 到 1000 之间")
        rows = self.connection.execute(
            """SELECT trade_id,idempotency_key,state,asset,quote,long_symbol,short_symbol,target_quantity,
                      net_base_exposure,open_quantity,created_at_ms,updated_at_ms
               FROM shadow_trades ORDER BY created_at_ms DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]

    def trade_position(self, trade_id: str) -> tuple[str, str, str, Decimal]:
        row = self.connection.execute(
            "SELECT state,long_symbol,short_symbol,open_quantity FROM shadow_trades WHERE trade_id=?", (trade_id,)
        ).fetchone()
        if row is None:
            raise KeyError(trade_id)
        return str(row["state"]), str(row["long_symbol"]), str(row["short_symbol"]), Decimal(str(row["open_quantity"]))


class ShadowExecutionEngine:
    """用下一份真实盘口模拟两腿 IOC，并在失衡时立即模拟补偿平仓。"""

    def __init__(self, store: ShadowStore) -> None:
        self.store = store

    def open(
        self,
        opportunity: Opportunity,
        books: list[OrderBook],
        *,
        idempotency_key: str,
        long_fill_ratio: Decimal = Decimal(1),
        short_fill_ratio: Decimal = Decimal(1),
        now_ms: int | None = None,
    ) -> ShadowTradeResult:
        existing = self.store.existing(idempotency_key)
        if existing is not None:
            return existing
        if opportunity.execution_status not in {"RESEARCH_DEPTH_VERIFIED", "EXECUTION_READY"}:
            raise ValueError("只有通过盘口深度校验的候选才能进入影子执行")
        for ratio in (long_fill_ratio, short_fill_ratio):
            if ratio < 0 or ratio > 1:
                raise ValueError("模拟成交比例必须在 0 到 1 之间")
        timestamp = int(time.time() * 1000) if now_ms is None else now_ms
        try:
            trade_id = self.store.create(opportunity, idempotency_key, timestamp)
        except sqlite3.IntegrityError:
            # 两个进程同时使用同一幂等键时，唯一约束是最终防线；输掉竞态的一方只读已有结果。
            existing = self.store.existing(idempotency_key)
            if existing is None:
                raise
            return existing
        quantity = opportunity.executable_quantity
        assert quantity is not None
        book_map = {item.symbol: item for item in books}
        long_fill = _attempt_fill(
            "LONG_OPEN", opportunity.long_symbol, "BUY", quantity, long_fill_ratio, book_map
        )
        short_fill = _attempt_fill(
            "SHORT_OPEN", opportunity.short_symbol, "SELL", quantity, short_fill_ratio, book_map
        )

        exposure = long_fill.filled_quantity - short_fill.filled_quantity
        opening_fills = (long_fill, short_fill)
        if exposure == 0 and long_fill.filled_quantity == quantity:
            self.store.transition(trade_id, "PLANNED", "OPEN", opening_fills, Decimal(0), quantity, timestamp)
            return self.store.result(trade_id)
        matched_quantity = min(long_fill.filled_quantity, short_fill.filled_quantity)
        self.store.transition(
            trade_id, "PLANNED", "REPAIR_REQUIRED", opening_fills, exposure, matched_quantity, timestamp
        )

        try:
            if exposure > 0:
                repair = _simulate_fill("REPAIR", opportunity.long_symbol, "SELL", exposure, Decimal(1), book_map)
                remaining = exposure - repair.filled_quantity
            elif exposure < 0:
                repair = _simulate_fill("REPAIR", opportunity.short_symbol, "BUY", -exposure, Decimal(1), book_map)
                remaining = exposure + repair.filled_quantity
            else:
                repair = None
                remaining = Decimal(0)
        except ValueError:
            repair = None
            remaining = exposure
        if remaining != 0:
            state = "MANUAL_INTERVENTION"
        elif matched_quantity > 0:
            state = "OPEN_PARTIAL"
        else:
            state = "ABORTED_FLAT"
        self.store.transition(
            trade_id, "REPAIR_REQUIRED", state, () if repair is None else (repair,), remaining,
            matched_quantity, timestamp,
        )
        return self.store.result(trade_id)

    def close(
        self,
        trade_id: str,
        books: list[OrderBook],
        *,
        long_fill_ratio: Decimal = Decimal(1),
        short_fill_ratio: Decimal = Decimal(1),
        now_ms: int | None = None,
    ) -> ShadowTradeResult:
        """用新盘口模拟 reduce-only 平仓；任一腿残留都会转人工处理，不伪装成已关闭。"""
        state, long_symbol, short_symbol, quantity = self.store.trade_position(trade_id)
        if state not in {"OPEN", "OPEN_PARTIAL"}:
            raise ValueError(f"{trade_id} 当前状态 {state} 不允许平仓")
        for ratio in (long_fill_ratio, short_fill_ratio):
            if ratio < 0 or ratio > 1:
                raise ValueError("模拟成交比例必须在 0 到 1 之间")
        timestamp = int(time.time() * 1000) if now_ms is None else now_ms
        book_map = {item.symbol: item for item in books}
        long_close = _attempt_fill("LONG_CLOSE", long_symbol, "SELL", quantity, long_fill_ratio, book_map)
        short_close = _attempt_fill("SHORT_CLOSE", short_symbol, "BUY", quantity, short_fill_ratio, book_map)
        long_remaining = quantity - long_close.filled_quantity
        short_remaining = quantity - short_close.filled_quantity
        exposure = long_remaining - short_remaining
        remaining_matched = min(long_remaining, short_remaining)
        next_state = "CLOSED" if long_remaining == 0 and short_remaining == 0 else "MANUAL_INTERVENTION"
        self.store.transition(
            trade_id, state, next_state, (long_close, short_close), exposure, remaining_matched, timestamp
        )
        return self.store.result(trade_id)


def _simulate_fill(
    leg: str,
    symbol: str,
    side: str,
    requested: Decimal,
    ratio: Decimal,
    books: dict[str, OrderBook],
) -> ShadowFill:
    filled = requested * ratio
    if filled == 0:
        return ShadowFill(leg, symbol, side, requested, Decimal(0), None, Decimal(0), "NO_FILL")
    book = books.get(symbol)
    if book is None:
        raise ValueError(f"{symbol} 缺少影子执行盘口")
    quote = quote_order_book(book, side, filled)
    status = "FILLED" if filled == requested else "PARTIALLY_FILLED"
    return ShadowFill(leg, symbol, side, requested, filled, quote.average_price, quote.quote_amount, status)


def _attempt_fill(
    leg: str,
    symbol: str,
    side: str,
    requested: Decimal,
    ratio: Decimal,
    books: dict[str, OrderBook],
) -> ShadowFill:
    """影子撮合失败按零成交记录，后续状态机必须据此修复敞口。"""
    try:
        return _simulate_fill(leg, symbol, side, requested, ratio, books)
    except ValueError:
        return ShadowFill(leg, symbol, side, requested, Decimal(0), None, Decimal(0), "REJECTED")


def fill_to_dict(fill: ShadowFill) -> dict[str, object]:
    data = asdict(fill)
    for key, value in tuple(data.items()):
        if isinstance(value, Decimal):
            data[key] = str(value)
    return data


def result_to_dict(result: ShadowTradeResult) -> dict[str, object]:
    return {
        "trade_id": result.trade_id,
        "state": result.state,
        "net_base_exposure": str(result.net_base_exposure),
        "open_quantity": str(result.open_quantity),
        "gross_execution_cashflow": str(result.gross_execution_cashflow),
        "fills": [fill_to_dict(item) for item in result.fills],
    }
