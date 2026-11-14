/**
 * 影子期统计：发布延迟分布、信号量、当前推定持仓。
 * 用于 spec §11.5 的 48 小时验收。
 */

import { fileURLToPath } from "node:url";
import { Store } from "../adapters/sqlite/store.ts";

const ROOT = process.env.RADAR_ROOT ?? fileURLToPath(new URL("../..", import.meta.url));
const dbPath = process.env.DB_PATH ?? `${ROOT}/var/radar.sqlite`;
const store = new Store(dbPath);

const allOrders = store.listSignals(10_000);
console.log(`信号总数（近 1 万条上限）：${allOrders.length}`);

const byAction = new Map<string, number>();
for (const row of allOrders) {
  byAction.set(row.action, (byAction.get(row.action) ?? 0) + 1);
}
console.log("按动作：", Object.fromEntries(byAction));

// 延迟从 lead_order 表算：detected_at - order_update_time。
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(dbPath, { readOnly: true });
const delays = (
  db
    .prepare("SELECT detected_at - order_update_time AS d FROM lead_order WHERE detected_at > 0 ORDER BY d")
    .all() as Array<{ d: number }>
).map((row) => row.d);
if (delays.length === 0) {
  console.log("还没有影子期订单样本。");
} else {
  const at = (p: number) => delays[Math.min(delays.length - 1, Math.floor(p * delays.length))]!;
  console.log(
    `延迟样本 ${delays.length} 笔：p50=${Math.round(at(0.5) / 1000)}s p90=${Math.round(at(0.9) / 1000)}s max=${Math.round(delays[delays.length - 1]! / 1000)}s`,
  );
}

const ledger = store.loadLedger("aoying");
const open = [...ledger.values()].filter((state) => Math.abs(state.netQty) > 1e-6);
console.log("推定未平仓：");
for (const state of open) {
  const flag = state.unknownBaseline ? "（基线未知）" : "";
  console.log(`  ${state.symbol} ${state.direction} ${state.netQty} @ ${state.avgOpenPrice.toFixed(4)} ${flag}`);
}
if (open.length === 0) {
  console.log("  （无）");
}
db.close();
store.close();
