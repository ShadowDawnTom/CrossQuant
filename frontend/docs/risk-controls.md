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
| `GCT_FUNDING_MAX_EXIT_SLIPPAGE_BPS` | `10` | 按当前多档盘口估算的最大退出滑点；超过后触发退出 |
| `GCT_FUNDING_MAX_BASIS_BPS` | `30` | 两腿可执行均价的最大基差 |
| `GCT_FUNDING_MAX_HOLDING_MS` | `86400000` | Canary 硬性最长持仓，默认 24 小时 |
| `GCT_FUNDING_SOFT_REVIEW_MS` | `28800000` | 8 小时后进入人工重点复核，但优势仍为正时不强制平仓 |
| `GCT_FUNDING_HOLDING_MONITOR_INTERVAL_MS` | `60000` | 开仓组合滚动评估周期 |
| `GCT_FUNDING_HOLDING_STALE_MS` | `180000` | 监控超过该时间未更新时锁死新单并安全退出 |
| `GCT_FUNDING_HOLDING_EVENTS_PER_LEG` | `2` | 每轮评估每条腿未来真实结算事件数量 |
| `GCT_FUNDING_HOLDING_EXIT_CONFIRMATIONS` | `3` | 普通边际收益不足连续确认次数；资金费反转不等待 |
| `GCT_FUNDING_MIN_HOLD_VALUE_USD` | `0` | 未来结算保守收入扣新增风险后的最低继续持有价值 |
| `GCT_FUNDING_SETTLEMENT_GUARD_MS` | `30000` | 结算前后保护窗口，暂停普通收益退出判断 |
| `GCT_FUNDING_SETTLEMENT_GRACE_MS` | `300000` | 结算后等待账户流水的宽限时间 |
| `GCT_FUNDING_SETTLEMENT_MAX_ERROR_USD` | `0.001` | 实际资金费与预期的最大绝对误差 |
| `GCT_FUNDING_SETTLEMENT_MAX_ERROR_RATIO` | `0.5` | 实际资金费与预期的最大相对误差 |
| `GCT_FUNDING_CONFIRMATION_COUNT` | `3` | 同一候选连续通过检查的次数 |
| `GCT_FUNDING_CONFIRMATION_WINDOW_MS` | `180000` | 连续确认窗口；需覆盖三轮 60 秒扫描及少量接口延迟 |
| `GCT_FUNDING_MIN_NET_ANNUALIZED` | `0.10` | 扣除模型成本后的最低年化收益，小数表示 |
| `GCT_FUNDING_LEVERAGE` | `1` | 两腿保证金预检和下单前确认的杠杆 |
| `GCT_FUNDING_SCAN_TARGET_NOTIONAL_USD` | `5` | 后端自动扫描时的单腿目标金额 |
| `GCT_FUNDING_SCAN_ASSETS` | 跟随执行行情资产 | 严格实盘候选白名单；探索资产不能自动加入 |
| `GCT_FUNDING_SCAN_HORIZON_HOURS` | `24` | 当前费率快照的现金流情景期，不是预测 |
| `GCT_FUNDING_SCAN_INTERVAL_MS` | `60000` | 后端自动候选扫描周期；禁止重叠请求，避免占满 Gate 鉴权限频 |
| `GCT_FUNDING_RETENTION_FACTOR` | `0.5` | 正向当前资金费快照在保守情景中只保留的比例 |
| `GCT_FUNDING_STRESS_SLIPPAGE_BPS` | `5` | 当前多档盘口以外额外扣除的下单延迟/滑点压力 |
| `GCT_FUNDING_ADVERSE_EXIT_BASIS_BPS` | `10` | 未来退出基差逆向变化缓冲 |
| `GCT_FUNDING_PAPER_ENABLED` | `0` | 独立模拟盘开关；开启后仍不会调用订单接口 |
| `GCT_FUNDING_PAPER_MAX_OPEN_POSITIONS` | `3` | 同时存在的模拟套利组合上限 |
| `GCT_FUNDING_RESEARCH_ENABLED` | `0` | 独立探索模拟开关；不会调用订单接口或放宽实盘候选 |
| `GCT_FUNDING_RESEARCH_ASSETS` | 80 个研究候选币 | 轻量发现资产；不要求全部常驻订单簿，最多 100 个 |
| `GCT_FUNDING_RESEARCH_TARGET_NOTIONAL_USD` | `5` | 单腿目标金额；仍按共同最小数量向上取整 |
| `GCT_FUNDING_RESEARCH_MAX_ACTUAL_NOTIONAL_USD` | `10` | 数量取整后任一腿的模拟金额硬上限；超过即拒绝 |
| `GCT_FUNDING_RESEARCH_MAX_OPEN_POSITIONS` | `3` | 每个实验组最多 3 个不同组合；实盘仍最多 1 组 |
| `GCT_FUNDING_RESEARCH_MAX_SLIPPAGE_BPS` | `10` | 研究开仓与退出各自允许的组合多档滑点上限 |
| `GCT_FUNDING_RESEARCH_MIN_SETTLED_EVENTS` | `1` | 一次结算组每条腿至少经历的模拟结算次数 |
| `GCT_FUNDING_RESEARCH_MIN_LIQUIDITY_USD` | `1000` | 10bp 范围内开平四个方向的最小 USD 深度 |
| `GCT_FUNDING_RESEARCH_LIQUIDITY_DEPTH_BPS` | `10` | 流动性统计的盘口价格范围 |
| `GCT_FUNDING_RESEARCH_MAX_PAIRS_PER_ASSET` | `1` | 每个币只深算毛费率优势最强的组合，控制 API 与磁盘占用 |
| `GCT_FUNDING_RESEARCH_STABLECOIN_RISK_BPS` | `5` | USD/USDC/USDT 跨报价组合的额外脱锚缓冲 |
| `GCT_FUNDING_RESEARCH_ROLLING_MIN_HOLDING_MS` | `86400000` | 仅滚动研究组的 24 小时最短观察期；期间普通价值转负只记录，方向反转和硬风控仍可退出 |
| `GCT_FUNDING_RESEARCH_ROLLING_SOFT_REVIEW_MS` | `259200000` | 滚动组 72 小时重点观察提醒 |
| `GCT_FUNDING_RESEARCH_ROLLING_HARD_HOLDING_MS` | `604800000` | 滚动组 7 天硬性退出上限 |
| `GCT_FUNDING_RESEARCH_MODEL_VERSION` | `rolling_v7` | 当前研究账本版本；切换版本会隔离统计并归档旧版未平模拟仓位 |
| `GCT_FUNDING_RESEARCH_HOLD_EXIT_CONFIRMATIONS` | `180` | 最短观察期结束后，继续持有价值不为正的连续有效扫描确认数，默认约 3 小时 |
| `GCT_FUNDING_RESEARCH_REVERSAL_EXIT_CONFIRMATIONS` | `60` | 滚动组资金费方向反转的连续有效扫描确认数，默认约 1 小时；最短观察期不会覆盖该退出 |
| `GCT_FUNDING_RESEARCH_REENTRY_COOLDOWN_MS` | `43200000` | 研究组平仓后的最短重开冷却，实际还会等待两条腿都跨过下一结算点 |
| `GCT_FUNDING_RESEARCH_HOLD_STRESS_SLIPPAGE_BPS` | `2` | 仅研究滚动组继续持有评估使用的新增滑点压力；不改变实盘入场风控 |
| `GCT_FUNDING_RESEARCH_HOLD_ADVERSE_BASIS_BPS` | `3` | 仅研究滚动组继续持有评估使用的新增基差缓冲；不改变实盘入场风控 |
| `GCT_FUNDING_RESEARCH_MAKER_FILL_PROBABILITY` | `0.35` | Maker/Taker 反事实中的保守完整对冲成交概率 |
| `GCT_FUNDING_RESEARCH_MAKER_LEG_RISK_BPS` | `5` | Maker 腿未成交时的裸露敞口期望损失缓冲 |
| `GCT_FUNDING_DISCOVERY_HOT_POOL_SIZE` | `10` | 同时维护完整 WebSocket 订单簿的动态热池，限制为 8～12 个币 |
| `GCT_FUNDING_DISCOVERY_MIN_OPEN_INTEREST_USD` | `1000000` | 两腿中较小持仓量的热池准入门槛 |
| `GCT_FUNDING_DISCOVERY_PROMOTION_CONFIRMATIONS` | `3` | 进入热池前连续满足轻量条件的扫描次数 |
| `GCT_FUNDING_DISCOVERY_MIN_EDGE_DURATION_MS` | `900000` | 费率方向至少稳定 15 分钟后才允许进入热池 |
| `GCT_FUNDING_DISCOVERY_MAX_DIRECTION_FLIPS_24H` | `3` | 24 小时方向翻转超过该值时拒绝进入热池 |
| `GCT_FUNDING_DISCOVERY_SNAPSHOT_INTERVAL_MS` | `300000` | 轻量发现历史落库间隔 |
| `GCT_FUNDING_DISCOVERY_MIN_HOT_DWELL_MS` | `1800000` | 热池最短驻留时间，避免订阅随分钟噪声反复切换 |

只有 `LIVE_SYNCHRONIZED` 盘口可以通过入场预检。缺价格、深度不足、行情陈旧、跨所时间差过大、账户快照不完整、私有流断线和 Kill Switch 已触发都会 fail-closed。

候选只由后端读取 Gate 已认证 `funding_info` 和账户手续费生成，浏览器不能提交资金费率或年化。接口值只用于“当前费率不变”的快照情景，不代表未来确定收益。扫描器按各所结算事件计数，用当前多档盘口计算立即往返价格损益，扣除开平仓四次 taker 手续费，并对正向资金费打折、额外扣除滑点和未来退出基差压力缓冲。真实结算历史达到 7 个完整 UTC 日后，保守持续率还会取“人工上限”和“历史正收益日命中率”中的较低值；入场仍会重新校验合约状态、数量规则、预计总敞口和可用保证金。

`GCT_AUTH_TRADER_EMAILS` 是交易员白名单，必须是 `GCT_AUTH_ALLOWED_EMAILS` 的子集。只在访问白名单而不在交易员白名单的账号可以看页面，但资金费入场和平仓接口都会返回 `trader_role_required`。

建议 10 USDT 验收阶段保持实盘开关关闭、单独开启模拟盘。通过至少 24 小时模拟验收后，再按交易所最小下单规则选择币对；不要直接照抄以下示例数值：

```dotenv
GCT_FUNDING_LIVE_ENABLED=0
GCT_FUNDING_PAPER_ENABLED=1
GCT_FUNDING_PAPER_MAX_OPEN_POSITIONS=3
GCT_EXECUTION_MARKET_SYMBOLS=BTC,ETH,SOL,XRP,BNB,ZEC,LINK,SUI,HYPE,UNITREE
GCT_FUNDING_SCAN_ASSETS=BTC,ETH,SOL
GCT_FUNDING_RESEARCH_ENABLED=1
GCT_FUNDING_RESEARCH_ASSETS=BTC,ETH,SOL,XRP,ZEC,BNB,SNDK,UNITREE,PUMP,SUI,ONDO,MSTRX,APT,TAO,LIT,LINK,AAVE,LDO,PYTH,HYPE,ARB,COINX,CRV,NVDAX,GOOGLX,MSFT,WLFI,IO,AI,AERO,ASTER,UNI,AKT,SKY,ZK,MORPHO,BREV,SKHYNIX
GCT_FUNDING_RESEARCH_TARGET_NOTIONAL_USD=5
GCT_FUNDING_RESEARCH_MAX_ACTUAL_NOTIONAL_USD=10
GCT_FUNDING_RESEARCH_MAX_OPEN_POSITIONS=3
GCT_FUNDING_RESEARCH_MODEL_VERSION=rolling_v7
GCT_FUNDING_RESEARCH_ROLLING_MIN_HOLDING_MS=86400000
GCT_FUNDING_RESEARCH_HOLD_EXIT_CONFIRMATIONS=180
GCT_FUNDING_RESEARCH_REVERSAL_EXIT_CONFIRMATIONS=60
GCT_FUNDING_RESEARCH_REENTRY_COOLDOWN_MS=43200000
GCT_FUNDING_RESEARCH_HOLD_STRESS_SLIPPAGE_BPS=2
GCT_FUNDING_RESEARCH_HOLD_ADVERSE_BASIS_BPS=3
GCT_FUNDING_MAX_NOTIONAL_PER_LEG_USD=5
GCT_FUNDING_MAX_CONCURRENT_TRADES=1
GCT_FUNDING_MAX_UNHEDGED_MS=1500
GCT_FUNDING_MAX_NET_BASE_EXPOSURE=0.01
GCT_FUNDING_MAX_ENTRY_SLIPPAGE_BPS=5
GCT_FUNDING_MAX_EXIT_SLIPPAGE_BPS=10
GCT_FUNDING_MAX_BASIS_BPS=30
GCT_FUNDING_SOFT_REVIEW_MS=28800000
GCT_FUNDING_MAX_HOLDING_MS=86400000
```

## 状态机与人工接管

入场会先冻结一个持久化交易意图，再用稳定的客户端订单号并发提交两腿 FOK/IOC。私有 WebSocket 推送优先更新状态，REST 查单兜底。部分成交或一腿失败时，执行器只会用 reduce-only IOC 反向清理多余仓位；修复仍无法确认就进入 `MANUAL_INTERVENTION`、触发 Kill Switch，并拒绝新单。

重启恢复不会重新发送普通入场单。它会查询已有订单并核对真实仓位；任何无法证明两腿等量的状态都转人工。平仓使用两腿 reduce-only，未完全成交的腿会再做一次减仓确认。

开仓后每分钟按两边各自真实的下一结算时间和结算间隔生成现金流事件。继续持有价值只扣未来新增风险，不会重复扣已经发生的开仓手续费；当前立即平仓 PnL 会单独计入价格损益、已到账资金费和预计退出手续费。普通收益不足需连续三轮确认，资金费方向反转、仓位漂移、基差/退出滑点超限、监控陈旧、私有流从 LIVE 掉线、结算未到账或金额异常以及硬性持仓上限会直接触发安全退出。结算前后保护窗口会暂停普通收益退出，避免为了几秒钟的费率抖动错过已接近的结算。

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
