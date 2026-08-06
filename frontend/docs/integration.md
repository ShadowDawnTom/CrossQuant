# Gate CrossEx integration

This document records the external API boundary needed to review the adapters. Gate's official references remain authoritative:

- `https://www.gate.com/docs/developers/crossex/en/`
- `https://www.gate.com/docs/developers/crossex/ws/en/`
- `https://www.gate.com/docs/developers/apiv4/en/`

## REST boundary

CrossEx REST is served below `https://api.gateio.ws/api/v4/crossex/*`. The adapter exposes a fixed allowlist rather than a generic authenticated proxy:

- account, positions, margin positions, open orders, fills, fees, transfers, and account-ledger reads;
- instrument and risk-limit discovery;
- order creation, order cancellation, leverage updates, and Spot/CrossEx transfers.

Private requests use Gate APIv4 `KEY`, `Timestamp`, and HMAC-SHA512 `SIGN` authentication. Order-placement requests also include the disclosed `X-Gate-Channel-Id: yourquantguy`; other authenticated requests do not.

`GET /crossex/rule/symbols` is the runtime source of truth for venue/product availability and trading limits. The application does not infer that an instrument exists from a static venue list. Gate documents no CrossEx testnet, so execution is production-only.

## WebSocket boundary

- Public endpoint: `wss://api.gateio.ws/ws/crossex/public`
- Private endpoint: `wss://api.gateio.ws/ws/crossex`

The market hub validates and relays public `ticker`, `funding_rate`, `open_interest`, `order_book_update`, `trade`, and kline channels. Detailed subscriptions are opened only for watched markets and are bounded, batched, and removed when no client needs them.

After authenticated login, the private stream subscribes account-wide to `order`, `usertrades`, `position`, `margin_position`, and `asset`. REST snapshots bootstrap and periodically reconcile the in-memory projection so disconnects or missed pushes do not silently become authoritative.

The application routes writes through the reviewed REST adapter rather than CrossEx WebSocket API write channels.

## Public venue data

CrossEx REST does not provide every candle, current-funding, funding-history, or bulk open-interest view required by the UI. Unauthenticated adapters query official public APIs for Gate, Binance, OKX, Bybit, Kraken, Hyperliquid, and Deribit. Every response is schema-validated and mapped back to a validated CrossEx instrument; public reference data never authorizes trading.

## Execution controls

Every backend start is locked. Writes require the appropriate API permission, an explicit live-mode acknowledgement, local Host/Origin and intent checks, schema validation, and audit logging. Strategy execution uses acknowledged remote order state, refuses stale or seed prices, reconciles ambiguous outcomes, and pauses when exposure cannot be repaired safely.
