# lead-trade-radar

监控币安合约带单员的**已成交委托**，每笔整理成一条 Telegram 信号，供人手动跟单。
不下单、不持有交易 API Key、不计算建议仓位。

规则与口径见 [`docs/spec.md`](docs/spec.md)。

## 能力

- 带单员隐藏持仓（`positionShow=false`）也能跟：站内订单流是公开的。
- 用订单流重建推定持仓，用已平仓位记录校准锚点。
- 平仓消息带杠杆、ROI、持有时间。
- 多人配置；首次启动静默建基线，不刷屏。
- 接口字段变化、连续拉取失败、带单员停单都会告警。

## 快速开始

```bash
cd ~/projects/lead-trade-radar
npm install
cp .env.example .env && chmod 600 .env   # 填 Telegram token / chat id

# 本地预览：bootstrap + 跑一轮，只打印不发；默认写 var/preview.sqlite，不碰生产库
npm run once

# 回放最近的真实订单，看消息长什么样
npm run replay

# 影子期统计：延迟 p50/p90、信号量、推定持仓
npm run stats
```

## 配置

`config/traders.yaml`：

```yaml
pollSeconds: 60
bootstrapDays: 14
push: false          # true 才会发 Telegram

traders:
  - id: aoying
    portfolioId: "5075281354358777856"   # 带单页 URL 末尾的数字
    label: 熬鹰资本
    enabled: true
```

`portfolioId` 取 `https://www.binance.com/zh-CN/copy-trading/lead-details/<这串数字>`。

## 常驻

```bash
mkdir -p ~/.config/systemd/user
cp deploy/lead-trade-radar.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now lead-trade-radar
journalctl --user -u lead-trade-radar -f
```

`deploy/lead-trade-radar.service` 用 `%h` 表示当前用户 home，默认假定项目在
`~/projects/lead-trade-radar`；Node 路径按自己的安装位置改。

## 环境变量

| 变量 | 说明 |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather 给的 token |
| `TELEGRAM_CHAT_ID` | 私聊或群组 id |
| `RADAR_PUSH` | `1`/`0`，临时覆盖配置里的 push |
| `CONFIG_PATH` | 默认 `config/traders.yaml` |
| `DB_PATH` | 默认 `var/radar.sqlite` |
| `HTTPS_PROXY` | 默认 `http://127.0.0.1:7890`（启动脚本已设） |

## 数据与免责声明

- `test/fixtures/` 是 2026-11-14 从币安带单页抓的**公开数据**，包含带单员公开昵称、
  portfolioId 与已成交委托字段，仅用于离线回放测试，不代表任何投资建议。
- 本项目与币安无关联；接口是站内未公开接口，没有 SLA，可能随时失效。
- 只做信号呈报，不下单、不持有交易 API Key、不计算建议仓位。交易风险自负。

## 开发

```bash
npm run typecheck
npm test          # 离线，用 test/fixtures 里的真实响应回放
```

`test/fixtures/` 是 2026-11-14 从币安抓的真实响应：

- `orders-14d.json`：14 天 60 笔订单
- `positions.json`：108 条已平仓位
- `detail.json`：带单员详情

## 排错

| 现象 | 处理 |
|---|---|
| `SchemaChangedError` | 币安字段变了，先看 `docs/spec.md §2` 和原始响应，改适配器与 fixture |
| `全部端点不可用` | 检查代理；确认 `friendly` 路径是否也失效（`public` 已失效） |
| 消息延迟很大 | 看消息里的「延迟 Ns」，这是币安发布延迟 + 轮询间隔 |
| 重启后不补发 | 设计如此；需要补发就删 `var/radar.sqlite` 里的 `lead_order` 行 |
