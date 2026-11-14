import { describe, expect, it } from "vitest";
import { actionOf, meaningOf, orderBaseKey, orderDedupeKey } from "../src/domain/order.ts";
import type { LeadOrder } from "../src/domain/types.ts";

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

describe("订单分类", () => {
  it("双向持仓：买多是加仓、卖多是减仓", () => {
    expect(meaningOf(order({ side: "BUY", positionSide: "LONG" }))).toMatchObject({
      direction: "LONG",
      increase: true,
      signedQty: 1,
    });
    expect(meaningOf(order({ side: "SELL", positionSide: "LONG", totalPnl: 5 }))).toMatchObject({
      direction: "LONG",
      increase: false,
      signedQty: -1,
    });
    expect(meaningOf(order({ side: "SELL", positionSide: "SHORT" }))).toMatchObject({
      direction: "SHORT",
      increase: true,
    });
    expect(meaningOf(order({ side: "BUY", positionSide: "SHORT", totalPnl: 5 }))).toMatchObject({
      direction: "SHORT",
      increase: false,
    });
  });

  it("单向持仓：靠 totalPnl 区分开仓和平仓", () => {
    expect(meaningOf(order({ side: "BUY", positionSide: "BOTH", totalPnl: 0 })).direction).toBe("LONG");
    expect(meaningOf(order({ side: "BUY", positionSide: "BOTH", totalPnl: 12 })).direction).toBe("SHORT");
    expect(meaningOf(order({ side: "SELL", positionSide: "BOTH", totalPnl: 0 })).direction).toBe("SHORT");
    expect(meaningOf(order({ side: "SELL", positionSide: "BOTH", totalPnl: 12 })).direction).toBe("LONG");
  });

  it("开/加/减/平由账本前后持仓决定", () => {
    const meaning = meaningOf(order({ side: "BUY", positionSide: "LONG" }));
    expect(actionOf(meaning, 0, 1)).toBe("open");
    expect(actionOf(meaning, 1, 2)).toBe("add");
    const reduce = meaningOf(order({ side: "SELL", positionSide: "LONG", totalPnl: 3 }));
    expect(actionOf(reduce, 2, 1)).toBe("reduce");
    expect(actionOf(reduce, 1, 0)).toBe("close");
    // 账本未知时不能断言是开仓还是加仓，按加仓处理
    expect(actionOf(meaning, null, null)).toBe("add");
  });

  it("去重键包含数量与均价，后续补量会变成新信号", () => {
    const a = orderDedupeKey(order({ executedQty: 1, avgPrice: 100 }));
    const b = orderDedupeKey(order({ executedQty: 1, avgPrice: 100, orderUpdateTime: 9_999 }));
    const c = orderDedupeKey(order({ executedQty: 2, avgPrice: 100 }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // 同一毫秒的两笔独立委托（数量不同）不能共用一个去重键
    expect(orderBaseKey(order({ executedQty: 1 }))).toBe(orderBaseKey(order({ executedQty: 2 })));
    expect(orderDedupeKey(order({ executedQty: 1 }))).not.toBe(orderDedupeKey(order({ executedQty: 2 })));
  });
});
