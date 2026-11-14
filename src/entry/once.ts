/**
 * 单轮运行：bootstrap（如需要）+ 跑一轮，把信号打印出来。
 * 用于上线前的手工验收：`npm run once`。
 */

import { fileURLToPath } from "node:url";
import { BapiClient } from "../adapters/binance/bapi.ts";
import { createDepthFetcher, createMarkPriceFetcher } from "../adapters/binance/market.ts";
import { Store } from "../adapters/sqlite/store.ts";
import { TraderRunner } from "../app/runner.ts";
import { loadConfig } from "../config/config.ts";

const ROOT = process.env.RADAR_ROOT ?? fileURLToPath(new URL("../..", import.meta.url));
const configPath = process.env.CONFIG_PATH ?? `${ROOT}/config/traders.yaml`;
// 预览绝不能写生产库：否则订单会被标记为已处理，真实信号会被静默吞掉。
const dbPath = process.env.DB_PATH ?? `${ROOT}/var/preview.sqlite`;

const config = loadConfig(configPath);
const store = new Store(dbPath);
const client = new BapiClient({ fetch });
const priceOf = createMarkPriceFetcher(fetch);
const depthOf = createDepthFetcher(fetch);
const log = (message: string, extra: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...extra }));
};

const trader = config.traders.find((t) => t.enabled);
if (!trader) {
  throw new Error("配置里没有启用的交易员");
}

const runner = new TraderRunner(
  { store, client, notifier: null, push: false, bootstrapDays: config.bootstrapDays, now: Date.now, log, priceOf, depthOf },
  trader,
);

await runner.bootstrapIfNeeded();
const emitted = await runner.cycle();
console.log(`\n本轮新信号 ${emitted.length} 条：\n`);
for (const text of emitted) {
  console.log(text);
  console.log("---");
}
if (emitted.length === 0) {
  console.log("（没有新订单）");
}
store.close();
