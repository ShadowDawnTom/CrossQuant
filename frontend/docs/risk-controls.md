# Risk controls and global kill switch

The backend evaluates account risk before live activation, before risk-increasing direct orders or leverage changes, and on every strategy tick. A failed check switches the process to read-only mode, rejects new risk-increasing orders, cancels tracked open orders, and pauses every active strategy. Explicit reduce-only orders remain available for supervised risk reduction. Balanced positions are not blindly flattened because doing so can create a new one-leg exposure; unresolved positions require explicit review.

## Account limits

| Environment variable | Default | Meaning |
| --- | ---: | --- |
| `GCT_RISK_MAX_GROSS_EXPOSURE_USD` | `10000` | Maximum sum of absolute futures position values |
| `GCT_RISK_MIN_AVAILABLE_MARGIN_RATIO` | `0.25` | Minimum available margin divided by margin balance |
| `GCT_RISK_MAX_DAILY_LOSS_USD` | `200` | Maximum loss from today's realized PnL plus current unrealized PnL |
| `GCT_RISK_MAX_PORTFOLIO_AGE_MS` | `360000` | Maximum authenticated REST snapshot age |
| `GCT_RISK_MAX_ADL_RANK` | unset | Optional maximum CrossEx ADL rank; enabling it rejects missing ranks |
| `GCT_RISK_ALERT_WEBHOOK_URL` | unset | Optional POST webhook for kill-switch alerts; the payload contains only reason and time |

The private account stream must also be live. Invalid decimals, missing account data, failed reconciliation, stale snapshots, an incomplete current-day trade page, and missing ADL data when the ADL limit is enabled all fail closed. CrossEx ADL rank uses 1–5 with a larger value representing higher reduction priority; the backend deliberately uses the normalized CrossEx rank instead of venue-specific raw ranks. See the official [`GET /crossex/adl_rank` documentation](https://www.gate.com/docs/developers/crossex/en/#query-adl-position-reduction-ranking).

## Manual emergency stop

Local operators can trigger the same idempotent path:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:17840/api/risk/kill-switch `
  -Headers @{ 'x-gct-trading-intent' = 'trigger-kill-switch' } `
  -ContentType 'application/json' -Body '{"reason":"operator emergency stop"}'
```

Status is available from `GET /api/risk/kill-switch`. Re-enabling live mode requires a fresh authenticated portfolio refresh and a successful account-risk check.

## Independent watchdog

Run this in a separate terminal or process supervisor:

```powershell
npm run watchdog:risk
```

The watchdog polls the local health endpoint and triggers the kill switch after three unhealthy checks. Configure it with `GCT_WATCHDOG_URL`, `GCT_WATCHDOG_INTERVAL_MS`, and `GCT_WATCHDOG_FAILURE_LIMIT`.

If the backend is completely unreachable, the watchdog exits with code `2` so an external service manager or alerting system can escalate. It cannot cancel exchange orders through a dead backend; protection against total machine, power, or network failure still requires exchange-native controls and an independently hosted operator service.
