# Gate CrossEx 资金费率套利（Python）

这是一个安全优先的 Gate CrossEx MVP：读取多个底层交易所的永续合约资金费率、Ticker 和账户实际费率，生成资金费率快照情景候选。它不会把当前费率外推冒充为预期 APR。

当前版本只负责监控、计算和生成交易计划，**不会发送真实订单**。原因是 CrossEx 的 Ticker 接口不提供买一卖一或深度，仅凭最新价无法安全估计滑点，也无法保证双腿同时成交。

## 已实现

- Gate API v4 HMAC-SHA512 签名，查询字符串与请求体按实际发送字节签名
- CrossEx 交易对规则、资金费率、Ticker、账户费率、资产查询
- 按两所各自的下次结算时间和周期，逐个结算事件计算情景现金流
- 按相同基础币/计价币组合跨交易所配对
- 扣除双腿开平仓手续费和每次成交的滑点预算
- 价格缺失、时间戳无效、行情陈旧或跨所时差过大时直接拒绝候选
- JSON 输出包含拒绝原因；可将原始市场快照追加到 UTF-8 JSONL
- API Key 缺失时明确报错，`.env` 不会被 Git 跟踪
- 标准库单元测试，无第三方运行依赖

## 快速开始

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
Copy-Item .env.example .env
```

然后用 UTF-8 编辑 `.env`，填入 CrossEx API Key 和 Secret。建议先创建**只读、绑定 IP、无提现权限**的 Key。

```powershell
# 公开接口，不需要 Key
crossex-arb symbols --base BTC --quote USDT

# 检查签名和账户访问（不会下单）
crossex-arb account

# 扫描 BTC/ETH 的跨所永续资金费率机会
crossex-arb scan --assets BTC,ETH --quote USDT

# 输出 JSON，方便后续接数据库或告警
crossex-arb scan --assets BTC,ETH,SOL --json

# 持续采集时可指定快照日志（data/ 默认不进 Git）
crossex-arb scan --assets BTC,ETH,SOL --snapshot-log data/market-snapshots.jsonl
```

也可以不安装，直接运行：

```powershell
$env:PYTHONPATH = "src"
python -m crossex_arb scan --assets BTC,ETH
```

## 收益口径

程序假设“当前返回的资金费率在指定情景期不变”，但按两所真实的下次结算时间和周期分别计数：

```text
多腿资金现金流 = -多腿当前费率 × 情景期内多腿结算次数
空腿资金现金流 =  空腿当前费率 × 情景期内空腿结算次数
交易成本 = 2 × (多腿 taker 费率 + 空腿 taker 费率) + 4 × 单次滑点预算
情景期净收益 = 两腿资金现金流 - 交易成本预算
快照情景年化 = 情景期净收益 × 8760 / 情景小时
```

这里的 4 次成交是两条腿各开仓、平仓一次。“快照情景年化”只是比较指标，不是预期 APR。特别是 Deribit 字段是实时计算的 8 小时费率，不代表后续结算会保持不变。

## 配置

| 变量 | 默认值 | 含义 |
|---|---:|---|
| `ARB_SCENARIO_HORIZON_HOURS` | `24` | 当前费率快照情景的计算时长 |
| `ARB_MIN_SNAPSHOT_ANNUALIZED` | `0.10` | 最低快照情景年化，`0.10` 表示 10% |
| `ARB_MAX_MARK_PRICE_DIVERGENCE` | `0.003` | 两边标记价最大偏离，`0.003` 表示 0.3% |
| `ARB_MAX_TICKER_AGE_MS` | `10000` | 单边 Ticker 最大允许年龄（毫秒） |
| `ARB_MAX_TICKER_SKEW_MS` | `2000` | 两所 Ticker 最大时间差（毫秒） |
| `ARB_SLIPPAGE_BPS_PER_FILL` | `2` | 每次成交预留滑点，单位 bp |
| `ARB_DEFAULT_TAKER_FEE` | `0.0005` | 费率接口缺失时使用的保守兜底值 |

## 上实盘前必须补齐

1. 接入各底层交易所可成交盘口/深度，而不是使用 Ticker 最新价。
2. 用小额沙盒或人工盯盘完成双腿成交、部分成交、拒单和补偿平仓测试。
3. 增加最大名义价值、最大单币敞口、保证金率、ADL、熔断和紧急平仓规则。
4. 持久化订单状态并处理进程重启，确保不会重复下单。
5. 对照账户的单向/双向持仓模式验证 `position_side` 与 `reduce_only`。

`--snapshot-log` 只解决从现在开始保存资金费率、Ticker 和手续费快照的问题。它不包含历史实际结算、订单簿、成交回报或基差路径，所以当前仍不能计算可信的实盘 PnL、Sharpe、MDD 和尾部风险。

项目即使把 `ENABLE_LIVE_TRADING` 改为 `true` 也不会下单；该变量是为后续执行器预留的第二道开关。

## 验证

```powershell
python -m unittest discover -s tests -v
python -m compileall -q src tests
```

官方文档：

- [Gate CrossEx API](https://www.gate.com/docs/developers/crossex/zh_CN/)
- [Gate API v4](https://www.gate.com/docs/developers/apiv4/zh_CN/)

## 许可证边界

根目录 Python 代码与 `frontend/` 是两个不同来源的代码区域。本仓库不再宣称整体为 MIT；详细来源和分发边界见 [LICENSES.md](LICENSES.md)。
