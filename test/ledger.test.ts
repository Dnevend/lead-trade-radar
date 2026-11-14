import { describe, expect, it } from "vitest";
import { applyAnchor, applyOrder, createLedger, getState, seedFlat } from "../src/domain/ledger.ts";
import type { LeadOrder } from "../src/domain/types.ts";
import { loadPositions, sortedOrders } from "./helpers.ts";

function order(overrides: Partial<LeadOrder>): LeadOrder {
  return {
    symbol: "BTCUSDT",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    side: "BUY",
    positionSide: "LONG",
    type: "MARKET",
    executedQty: 1,
    avgPrice: 100,
    totalPnl: 0,
    orderTime: 1_000,
    orderUpdateTime: 1_000,
    ...overrides,
  };
}

describe("持仓账本", () => {
  it("开仓 → 加仓 → 平仓，净持仓归零", () => {
    const ledger = createLedger();
    seedFlat(ledger, "BTCUSDT", "LONG");
    const open = applyOrder(ledger, order({ executedQty: 2, avgPrice: 100 }));
    const add = applyOrder(ledger, order({ executedQty: 1, avgPrice: 130, orderTime: 2_000, orderUpdateTime: 2_000 }));
    const close = applyOrder(
      ledger,
      order({
        side: "SELL",
        executedQty: 3,
        avgPrice: 120,
        totalPnl: 30,
        orderTime: 3_000,
        orderUpdateTime: 3_000,
      }),
    );

    expect(open.action).toBe("open");
    expect(open.netAfter).toBe(2);
    expect(add.action).toBe("add");
    expect(add.netAfter).toBe(3);
    expect(add.avgOpenPrice).toBeCloseTo(110, 6);
    expect(close.action).toBe("close");
    expect(close.netAfter).toBe(0);
    expect(getState(ledger, "BTCUSDT", "LONG")?.netQty).toBe(0);
  });

  it("没有锚点时减仓，标记账本未知，不谎报持仓", () => {
    const ledger = createLedger();
    const transition = applyOrder(
      ledger,
      order({ side: "SELL", positionSide: "LONG", totalPnl: 50, executedQty: 5 }),
    );
    expect(transition.action).toBe("reduce");
    expect(transition.netBefore).toBeNull();
    expect(transition.netAfter).toBeNull();
    expect(getState(ledger, "BTCUSDT", "LONG")?.unknownBaseline).toBe(true);
  });

  it("锚点之前的订单不参与本轮累计", () => {
    const ledger = createLedger();
    applyAnchor(ledger, {
      positionId: "p1",
      symbol: "BTCUSDT",
      side: "Long",
      opened: 100,
      closed: 5_000,
      avgCost: 100,
      avgClosePrice: 110,
      closingPnl: 10,
      closedVolume: 1,
      leverage: 10,
      roi: 0.1,
      status: "All Closed",
    });
    const transition = applyOrder(
      ledger,
      order({ side: "SELL", executedQty: 1, avgPrice: 120, totalPnl: 20, orderTime: 4_000, orderUpdateTime: 4_000 }),
    );
    expect(transition.netAfter).toBeNull();
    expect(getState(ledger, "BTCUSDT", "LONG")?.netQty).toBe(0);
  });

  it("平仓记录与平仓订单同一毫秒到达时，仍判定为平仓", () => {
    const ledger = createLedger();
    seedFlat(ledger, "BTCUSDT", "LONG");
    applyOrder(ledger, order({ executedQty: 1, avgPrice: 100, orderTime: 1_000, orderUpdateTime: 1_000 }));
    applyOrder(ledger, order({ executedQty: 1, avgPrice: 110, orderTime: 2_000, orderUpdateTime: 2_000 }));

    // 实际 cycle 顺序：先应用订单，再用同轮的平仓记录校准
    const transition = applyOrder(
      ledger,
      order({ side: "SELL", executedQty: 2, avgPrice: 120, totalPnl: 30, orderTime: 5_000, orderUpdateTime: 5_000 }),
    );
    applyAnchor(ledger, {
      positionId: "p1",
      symbol: "BTCUSDT",
      side: "Long",
      opened: 1_000,
      closed: 5_000,
      avgCost: 105,
      avgClosePrice: 120,
      closingPnl: 30,
      closedVolume: 2,
      leverage: 10,
      roi: 0.3,
      status: "All Closed",
    });
    expect(transition.action).toBe("close");
    expect(transition.netAfter).toBe(0);
    expect(getState(ledger, "BTCUSDT", "LONG")?.netQty).toBe(0);
  });

  it("迟到的锚点不会抹掉它之后建立的新仓位", () => {
    const ledger = createLedger();
    // 基线未知：先看到一笔平仓（减到负数 → 标记 unknown）
    applyOrder(ledger, order({ side: "SELL", positionSide: "LONG", totalPnl: 5, executedQty: 5, orderTime: 1_000, orderUpdateTime: 1_000 }));
    // 随后反手开多
    applyOrder(ledger, order({ side: "BUY", positionSide: "LONG", executedQty: 3, avgPrice: 120, orderTime: 2_000, orderUpdateTime: 2_000 }));
    // 平仓记录晚一轮才到（closed=1500，早于新仓的 2000）
    applyAnchor(ledger, {
      positionId: "late",
      symbol: "BTCUSDT",
      side: "Long",
      opened: 100,
      closed: 1_500,
      avgCost: 100,
      avgClosePrice: 110,
      closingPnl: 5,
      closedVolume: 5,
      leverage: 10,
      roi: 0.1,
      status: "All Closed",
    });
    expect(getState(ledger, "BTCUSDT", "LONG")?.netQty).toBe(3);
  });

  it("同一组合有多条平仓记录时，锚点取最近一次", () => {
    const ledger = createLedger();
    const base = {
      positionId: "p",
      symbol: "ETHUSDT",
      side: "Short" as const,
      opened: 1,
      avgCost: 100,
      avgClosePrice: 110,
      closingPnl: 1,
      closedVolume: 1,
      leverage: 10,
      roi: 0.1,
      status: "All Closed",
    };
    applyAnchor(ledger, { ...base, positionId: "p1", closed: 1_000 });
    applyAnchor(ledger, { ...base, positionId: "p2", closed: 3_000 });
    expect(getState(ledger, "ETHUSDT", "SHORT")?.anchorClosedAt).toBe(3_000);
  });

  it("漏掉一笔减仓时，同轮到达的平仓记录能把账本拉回 0", () => {
    const ledger = createLedger();
    seedFlat(ledger, "BTCUSDT", "LONG");
    // 开 10，但漏掉了一笔减仓 4（账本仍以为有 10）
    applyOrder(ledger, order({ executedQty: 10, avgPrice: 100, orderTime: 1_000, orderUpdateTime: 1_000 }));
    // 全平订单实际只有 6
    const close = applyOrder(
      ledger,
      order({ side: "SELL", executedQty: 6, avgPrice: 120, totalPnl: 30, orderTime: 5_000, orderUpdateTime: 5_000 }),
    );
    expect(close.action).toBe("reduce");
    expect(close.netAfter).toBe(4);
    // 同一轮稍后到达的平仓记录（closed=5000）应把残留的 4 清零
    applyAnchor(ledger, {
      positionId: "p1",
      symbol: "BTCUSDT",
      side: "Long",
      opened: 1_000,
      closed: 5_000,
      avgCost: 100,
      avgClosePrice: 120,
      closingPnl: 30,
      closedVolume: 6,
      leverage: 10,
      roi: 0.3,
      status: "All Closed",
    });
    expect(getState(ledger, "BTCUSDT", "LONG")?.netQty).toBe(0);
    expect(getState(ledger, "BTCUSDT", "LONG")?.unknownBaseline).toBe(false);
  });

  it("同一毫秒平仓后反手，锚点不会把新仓清零", () => {
    const ledger = createLedger();
    seedFlat(ledger, "BTCUSDT", "LONG");
    applyOrder(ledger, order({ executedQty: 5, avgPrice: 100, orderTime: 1_000, orderUpdateTime: 1_000 }));
    applyOrder(
      ledger,
      order({ side: "SELL", executedQty: 5, avgPrice: 120, totalPnl: 30, orderTime: 5_000, orderUpdateTime: 5_000 }),
    );
    applyOrder(ledger, order({ executedQty: 3, avgPrice: 121, orderTime: 5_000, orderUpdateTime: 5_000 }));
    applyAnchor(ledger, {
      positionId: "p1",
      symbol: "BTCUSDT",
      side: "Long",
      opened: 1_000,
      closed: 5_000,
      avgCost: 100,
      avgClosePrice: 120,
      closingPnl: 30,
      closedVolume: 5,
      leverage: 10,
      roi: 0.3,
      status: "All Closed",
    });
    expect(getState(ledger, "BTCUSDT", "LONG")?.netQty).toBe(3);
    expect(getState(ledger, "BTCUSDT", "LONG")?.unknownBaseline).toBe(false);
  });

  it("反手订单晚于锚点到达时仍会入账", () => {
    const ledger = createLedger();
    seedFlat(ledger, "BTCUSDT", "LONG");
    applyOrder(ledger, order({ executedQty: 5, avgPrice: 100, orderTime: 1_000, orderUpdateTime: 1_000 }));
    applyOrder(
      ledger,
      order({ side: "SELL", executedQty: 5, avgPrice: 120, totalPnl: 30, orderTime: 5_000, orderUpdateTime: 5_000 }),
    );
    applyAnchor(ledger, {
      positionId: "p1",
      symbol: "BTCUSDT",
      side: "Long",
      opened: 1_000,
      closed: 5_000,
      avgCost: 100,
      avgClosePrice: 120,
      closingPnl: 30,
      closedVolume: 5,
      leverage: 10,
      roi: 0.3,
      status: "All Closed",
    });
    const reopen = applyOrder(
      ledger,
      order({ executedQty: 3, avgPrice: 121, orderTime: 5_000, orderUpdateTime: 5_000 }),
    );
    expect(reopen.netAfter).toBe(3);
    expect(reopen.action).toBe("open");
  });

  it("回放 14 天真实订单：只有 NVDA 多仓还是开着的", () => {
    const ledger = createLedger();
    for (const record of [...loadPositions()].sort((a, b) => a.closed - b.closed)) {
      applyAnchor(ledger, record);
    }
    for (const current of sortedOrders()) {
      applyOrder(ledger, current);
    }
    const open = [...ledger.values()].filter((state) => Math.abs(state.netQty) > 1e-6);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ symbol: "NVDAUSDT", direction: "LONG" });
    expect(open[0]!.netQty).toBeCloseTo(3206.99, 2);
    expect(open[0]!.avgOpenPrice).toBeCloseTo((1582.28 * 162.7877509 + 1624.71 * 162.711251) / 3206.99, 4);
  });

  it("回放不做锚定时，BTC 的动作序列与平仓记录一致", () => {
    const ledger = createLedger();
    seedFlat(ledger, "BTCUSDT", "LONG");
    const actions = sortedOrders()
      .filter((current) => current.symbol === "BTCUSDT")
      .map((current) => applyOrder(ledger, current).action);
    expect(actions).toEqual(["open", "close", "open", "add", "close"]);
  });
});
