/**
 * 常驻入口：systemd 用户服务调用。
 *
 * 环境变量：
 * - CONFIG_PATH  默认 <项目根>/config/traders.yaml
 * - DB_PATH      默认 <项目根>/var/radar.sqlite
 * - TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID  push=true 时必填
 * - RADAR_PUSH   1/0，覆盖配置里的 push（便于临时打开）
 */

import { fileURLToPath } from "node:url";
import { BapiClient, BapiError } from "../adapters/binance/bapi.ts";
import { createDepthFetcher, createMarkPriceFetcher } from "../adapters/binance/market.ts";
import { Store } from "../adapters/sqlite/store.ts";
import { TelegramClient } from "../adapters/telegram/client.ts";
import { FxTwitterClient } from "../adapters/x/client.ts";
import { TraderRunner } from "../app/runner.ts";
import { loadConfig, pollMsOf, type TraderConfig } from "../config/config.ts";

const ROOT = process.env.RADAR_ROOT ?? fileURLToPath(new URL("../..", import.meta.url));
const configPath = process.env.CONFIG_PATH ?? `${ROOT}/config/traders.yaml`;
const dbPath = process.env.DB_PATH ?? `${ROOT}/var/radar.sqlite`;

const config = loadConfig(configPath);
const push = process.env.RADAR_PUSH === "1" ? true : process.env.RADAR_PUSH === "0" ? false : config.push;

const store = new Store(dbPath);
const client = new BapiClient({ fetch });
const priceOf = createMarkPriceFetcher(fetch);
const depthOf = createDepthFetcher(fetch);
const tweetSource = new FxTwitterClient({ fetch });
const notifier =
  push && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
    ? new TelegramClient({
        token: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID,
        fetch,
      })
    : null;

if (push && !notifier) {
  throw new Error("push=true 但缺少 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID");
}

const log = (message: string, extra: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...extra }));
};

const enabledTraders = config.traders
  .filter((trader) => trader.enabled)
  .filter((trader) => {
    const row = store.getTrader(trader.id);
    if (row?.disabledReason) {
      log("跳过已停止的项目", { trader: trader.id, reason: row.disabledReason });
      return false;
    }
    return true;
  });
const runners = enabledTraders.map(
  (trader) =>
    new TraderRunner(
      { store, client, notifier, push, bootstrapDays: config.bootstrapDays, now: Date.now, log, priceOf, depthOf, tweetSource },
      trader,
    ),
);

const timers = new Map<string, NodeJS.Timeout>();
let keepalive: NodeJS.Timeout | null = null;
let stopping = false;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isProjectClosed(error: unknown): boolean {
  return error instanceof BapiError && error.code === "11012030";
}

async function startTrader(runner: TraderRunner, trader: TraderConfig, index: number): Promise<void> {
  const interval = pollMsOf(config, trader);
  // 多人时错开首轮，避免同时打接口。
  await sleep(index * Math.min(5_000, interval / 4));

  // bootstrap 失败不退出进程：单人失败不能影响其他人，systemd 也不会进 crash loop。
  while (!stopping) {
    try {
      await runner.bootstrapIfNeeded();
      break;
    } catch (error) {
      await runner.reportFailure(error);
      // 带单项目已关闭：重试没有意义，告警后停止该交易员。
      if (isProjectClosed(error)) {
        await runner.disable("带单项目已关闭（11012030）");
        return;
      }
      await sleep(30_000);
    }
  }
  if (stopping) return;

  void tick(runner);
  const timer = setInterval(() => void tick(runner), interval);
  timers.set(runner.ref.id, timer);
  log("已排程", { trader: trader.id, intervalMs: interval });
}

async function tick(runner: TraderRunner): Promise<void> {
  if (stopping) return;
  try {
    const emitted = await runner.cycle();
    if (emitted.length > 0) {
      log("本轮信号", { trader: runner.ref.id, count: emitted.length });
    }
  } catch (error) {
    await runner.reportFailure(error);
    if (isProjectClosed(error)) {
      const timer = timers.get(runner.ref.id);
      if (timer) clearInterval(timer);
      timers.delete(runner.ref.id);
      await runner.disable("带单项目已关闭（11012030）");
    }
  }
}

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log("收到退出信号", { signal });
  for (const timer of timers.values()) clearInterval(timer);
  if (keepalive) clearInterval(keepalive);
  store.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

void Promise.all(runners.map((runner, index) => startTrader(runner, enabledTraders[index]!, index)))
  .then(() => {
    // 所有交易员都被停用（如项目关闭）时保持进程存活，避免 systemd 每 5 秒重启。
    if (!stopping && timers.size === 0) {
      log("没有运行中的交易员，保持进程存活");
      keepalive = setInterval(() => {}, 3_600_000);
    }
  })
  .catch((error) => {
    log("启动失败", { error: String(error) });
    process.exit(1);
  });
