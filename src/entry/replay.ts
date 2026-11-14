/**
 * 离线回放：用 test/fixtures 里的真实响应重放订单，打印会推送的消息。
 * 不连网，用于人工检查文案和动作判断。
 */

import { applyAnchor, applyOrder, createLedger } from "../domain/ledger.ts";
import { renderOrderSignal } from "../domain/render.ts";
import { buildOrderSignal } from "../domain/signal.ts";
import type { ClosedPosition, LeadOrder } from "../domain/types.ts";
import { loadDetail, loadOrders, loadPositions } from "../../test/helpers.ts";

const detail = loadDetail();
const positions = loadPositions();
const orders = loadOrders().sort((a, b) => a.orderUpdateTime - b.orderUpdateTime || a.orderTime - b.orderTime);

const ledger = createLedger();
for (const record of [...positions].sort((a, b) => a.closed - b.closed)) {
  applyAnchor(ledger, record);
}

const trader = { id: "aoying", portfolioId: detail.leadPortfolioId, label: detail.nickname };
let shown = 0;
for (const order of orders) {
  const transition = applyOrder(ledger, order);
  const signal = buildOrderSignal(order, transition, {
    trader,
    detail,
    closedPositions: positions,
    markPrice: null,
    depth: null,
    detectedAt: order.orderUpdateTime + 30_000,
  });
  console.log(renderOrderSignal(signal));
  console.log("");
  shown += 1;
}

const open = [...ledger.values()].filter((state) => Math.abs(state.netQty) > 1e-6);
console.log(`共回放 ${shown} 笔订单；推定未平仓：`);
for (const state of open) {
  console.log(`  ${state.symbol} ${state.direction} ${state.netQty} @ ${state.avgOpenPrice}`);
}
