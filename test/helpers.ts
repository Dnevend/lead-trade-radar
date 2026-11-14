import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClosedPosition, LeadOrder, TraderDetail } from "../src/domain/types.ts";

const here = dirname(fileURLToPath(import.meta.url));

function read(name: string): unknown {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
}

export function loadOrders(): LeadOrder[] {
  const raw = read("orders-14d.json") as { data: { list: Array<Record<string, unknown>> } };
  return raw.data.list.map((row) => ({
    symbol: String(row.symbol),
    baseAsset: String(row.baseAsset),
    quoteAsset: String(row.quoteAsset),
    side: row.side as LeadOrder["side"],
    positionSide: row.positionSide as LeadOrder["positionSide"],
    type: String(row.type),
    executedQty: Number(row.executedQty),
    avgPrice: Number(row.avgPrice),
    totalPnl: Number(row.totalPnl),
    orderTime: Number(row.orderTime),
    orderUpdateTime: Number(row.orderUpdateTime),
  }));
}

export function loadPositions(): ClosedPosition[] {
  const raw = read("positions.json") as { data: { list: Array<Record<string, unknown>> } };
  return raw.data.list.map((row) => ({
    positionId: String(row.positionId),
    symbol: String(row.symbol),
    side: row.side === "Long" ? "Long" : "Short",
    opened: Number(row.opened),
    closed: Number(row.closed),
    avgCost: Number(row.avgCost),
    avgClosePrice: Number(row.avgClosePrice),
    closingPnl: Number(row.closingPnl),
    closedVolume: Number(row.closedVolume),
    leverage: Number(row.leverage),
    roi: Number(row.roi),
    status: String(row.status),
  }));
}

export function loadDetail(): TraderDetail {
  const raw = read("detail.json") as { data: Record<string, unknown> };
  return {
    leadPortfolioId: String(raw.data.leadPortfolioId),
    nickname: String(raw.data.nickname),
    status: String(raw.data.status),
    positionShow: Boolean(raw.data.positionShow),
    marginBalance: Number(raw.data.marginBalance),
    aumAmount: Number(raw.data.aumAmount),
    lastTradeTime: Number(raw.data.lastTradeTime),
  };
}

/** fxtwitter 的公开响应；只用于离线解析测试。 */
export function loadXStatuses(): unknown {
  return read("x-statuses.json");
}

export function sortedOrders(): LeadOrder[] {
  return loadOrders().sort((a, b) => a.orderUpdateTime - b.orderUpdateTime || a.orderTime - b.orderTime);
}
