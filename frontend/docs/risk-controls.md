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

## 资金费套利专用限制

资金费实盘状态机还有一层独立开关。即使普通交易模式是 live，`GCT_FUNDING_LIVE_ENABLED` 没有明确设为 `1` 时也不会入场。

| 环境变量 | 安全默认值 | 说明 |
| --- | ---: | --- |
| `GCT_FUNDING_LIVE_ENABLED` | `0` | 资金费实盘总开关 |
| `GCT_FUNDING_MAX_NOTIONAL_PER_LEG_USD` | `0` | 单腿最大名义金额 |
| `GCT_FUNDING_MAX_CONCURRENT_TRADES` | `0` | 同时持有的套利组合数 |
| `GCT_FUNDING_MAX_UNHEDGED_MS` | `1500` | 单腿裸露和订单确认的最长等待时间 |
| `GCT_FUNDING_MAX_NET_BASE_EXPOSURE` | `0` | 单币种允许的净基础币敞口；超过会告警并减仓 |
| `GCT_FUNDING_MAX_ENTRY_SLIPPAGE_BPS` | `5` | 按盘口多档均价计算的最大入场滑点 |
| `GCT_FUNDING_MAX_BASIS_BPS` | `30` | 两腿可执行均价的最大基差 |
| `GCT_FUNDING_MAX_HOLDING_MS` | `28800000` | 最长持仓时间，默认 8 小时 |
| `GCT_FUNDING_CONFIRMATION_COUNT` | `3` | 同一候选连续通过检查的次数 |
| `GCT_FUNDING_CONFIRMATION_WINDOW_MS` | `180000` | 连续确认窗口；需覆盖三轮 60 秒扫描及少量接口延迟 |
| `GCT_FUNDING_MIN_NET_ANNUALIZED` | `0.10` | 扣除模型成本后的最低年化收益，小数表示 |
| `GCT_FUNDING_LEVERAGE` | `1` | 两腿保证金预检和下单前确认的杠杆 |
| `GCT_FUNDING_SCAN_TARGET_NOTIONAL_USD` | `5` | 后端自动扫描时的单腿目标金额 |
| `GCT_FUNDING_SCAN_HORIZON_HOURS` | `24` | 当前费率快照的现金流情景期，不是预测 |
| `GCT_FUNDING_SCAN_INTERVAL_MS` | `60000` | 后端自动候选扫描周期；禁止重叠请求，避免占满 Gate 鉴权限频 |
| `GCT_FUNDING_RETENTION_FACTOR` | `0.5` | 正向当前资金费快照在保守情景中只保留的比例 |
| `GCT_FUNDING_STRESS_SLIPPAGE_BPS` | `5` | 当前多档盘口以外额外扣除的下单延迟/滑点压力 |
| `GCT_FUNDING_ADVERSE_EXIT_BASIS_BPS` | `10` | 未来退出基差逆向变化缓冲 |

只有 `LIVE_SYNCHRONIZED` 盘口可以通过入场预检。缺价格、深度不足、行情陈旧、跨所时间差过大、账户快照不完整、私有流断线和 Kill Switch 已触发都会 fail-closed。

候选只由后端读取 Gate 已认证 `funding_info` 和账户手续费生成，浏览器不能提交资金费率或年化。接口值只用于“当前费率不变”的快照情景，不代表未来确定收益。扫描器按各所结算事件计数，用当前多档盘口计算立即往返价格损益，扣除开平仓四次 taker 手续费，并对正向资金费打折、额外扣除滑点和未来退出基差压力缓冲；入场还会重新校验合约状态、`min_size`、`min_notional`、`lot_size`、`tick_size`、预计总敞口和可用保证金。

`GCT_AUTH_TRADER_EMAILS` 是交易员白名单，必须是 `GCT_AUTH_ALLOWED_EMAILS` 的子集。只在访问白名单而不在交易员白名单的账号可以看页面，但资金费入场和平仓接口都会返回 `trader_role_required`。

建议 10 USDT 验收阶段保持开关关闭，只跑影子交易。通过至少 24 小时影子验收后，再按交易所最小下单规则选择币对；不要直接照抄以下示例数值：

```dotenv
GCT_FUNDING_LIVE_ENABLED=0
GCT_FUNDING_MAX_NOTIONAL_PER_LEG_USD=5
GCT_FUNDING_MAX_CONCURRENT_TRADES=1
GCT_FUNDING_MAX_UNHEDGED_MS=1500
GCT_FUNDING_MAX_NET_BASE_EXPOSURE=0.01
GCT_FUNDING_MAX_ENTRY_SLIPPAGE_BPS=5
GCT_FUNDING_MAX_BASIS_BPS=30
GCT_FUNDING_MAX_HOLDING_MS=28800000
```

## 状态机与人工接管

入场会先冻结一个持久化交易意图，再用稳定的客户端订单号并发提交两腿 FOK/IOC。私有 WebSocket 推送优先更新状态，REST 查单兜底。部分成交或一腿失败时，执行器只会用 reduce-only IOC 反向清理多余仓位；修复仍无法确认就进入 `MANUAL_INTERVENTION`、触发 Kill Switch，并拒绝新单。

重启恢复不会重新发送普通入场单。它会查询已有订单并核对真实仓位；任何无法证明两腿等量的状态都转人工。平仓使用两腿 reduce-only，未完全成交的腿会再做一次减仓确认。资金费观察发现 `shortRate - longRate <= 0`，或达到最长持仓时间，也会触发后端平仓。

告警先写入 SQLite 的 `operational_alerts`，再发送 `GCT_RISK_ALERT_WEBHOOK_URL`。Webhook 失败不会阻塞撤单和 Kill Switch，同类告警在短窗口内会去重。

Telegram 可使用 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` 和 `TELEGRAM_REQUEST_TIMEOUT_MS`。真实值只能放服务器权限为 `0640` 的 EnvironmentFile；发送器会限制消息长度，并对 Telegram 429 最多退避重试三次。

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
