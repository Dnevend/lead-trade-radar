import { describe, expect, it } from "vitest";
import { renderOrderSignal } from "../src/domain/render.ts";
import { buildOrderSignal, matchClosedPosition } from "../src/domain/signal.ts";
import { renderTransfer } from "../src/app/runner.ts";
import { loadDetail, loadPositions, sortedOrders } from "./helpers.ts";

describe("信号渲染", () => {
  it("开仓消息包含方向、名义额和保证金占比", () => {
    const order = sortedOrders().find((o) => o.symbol === "NVDAUSDT" && o.side === "BUY")!;
    const signal = buildOrderSignal(
      order,
      { action: "add", direction: "LONG", netBefore: 1582.28, netAfter: 3206.99, avgOpenPrice: 162.749, avgOpenBefore: 162.711 },
      { trader: { id: "aoying", portfolioId: "x", label: "熬鹰资本" }, detail: loadDetail(), closedPositions: [], markPrice: null, depth: null, detectedAt: order.orderUpdateTime + 12_000 },
    );
    const text = renderOrderSignal(signal);
    expect(text).toContain("熬鹰资本 · 加多 NVDAUSDT");
    expect(text).toContain("名义 $");
    expect(text).toContain("≈ 他保证金");
    expect(text).toContain("推定持仓");
    expect(text).toContain("延迟 12s");
  });

  it("平仓消息用平仓记录的入场价、杠杆和持有时间", () => {
    const order = sortedOrders().find(
      (o) => o.symbol === "BTCUSDT" && o.side === "SELL" && o.totalPnl > 0 && o.executedQty > 10,
    )!;
    const positions = loadPositions();
    const matched = matchClosedPosition(positions, order, "LONG");
    expect(matched).not.toBeNull();
    const signal = buildOrderSignal(
      order,
      { action: "close", direction: "LONG", netBefore: order.executedQty, netAfter: 0, avgOpenPrice: 68088, avgOpenBefore: null },
      { trader: { id: "aoying", portfolioId: "x", label: "熬鹰资本" }, detail: loadDetail(), closedPositions: positions, markPrice: null, depth: null, detectedAt: order.orderUpdateTime + 60_000 },
    );
    const text = renderOrderSignal(signal);
    expect(text).toContain("熬鹰资本 · 平多 BTCUSDT");
    expect(text).toContain("68,108.64 → 69,984.80");
    expect(text).toContain("+27,837 USDT");
    expect(text).toContain("10x");
    expect(text).toContain("ROI 27.0%");
    expect(text).toContain("持有 7h38m");
  });

  it("浮亏加仓标「摊平」，浮盈加仓只报幅度", () => {
    const order = sortedOrders().find((o) => o.symbol === "NVDAUSDT" && o.side === "BUY")!;
    const ctx = {
      trader: { id: "aoying", portfolioId: "x", label: "熬鹰资本" },
      detail: loadDetail(),
      closedPositions: [],
      depth: null,
      detectedAt: order.orderUpdateTime,
    };

    const under = buildOrderSignal(
      order,
      { action: "add", direction: "LONG", netBefore: 1_000, netAfter: 2_000, avgOpenPrice: 100, avgOpenBefore: 100 },
      { ...ctx, markPrice: 92 },
    );
    const underText = renderOrderSignal(under);
    expect(under.averagingDown).toBe(true);
    expect(underText).toContain("⚠️");
    expect(underText).toContain("（摊平）");
    expect(underText).toContain("加仓前推定 -8.0%");

    const above = buildOrderSignal(
      order,
      { action: "add", direction: "LONG", netBefore: 1_000, netAfter: 2_000, avgOpenPrice: 100, avgOpenBefore: 100 },
      { ...ctx, markPrice: 110 },
    );
    const aboveText = renderOrderSignal(above);
    expect(above.averagingDown).toBe(false);
    expect(aboveText).not.toContain("（摊平）");
    expect(aboveText).toContain("加仓前推定 +10.0%");
  });

  it("持仓中的资金划转升级为风险提示", () => {
    const base = {
      time: 1_794_600_000_000,
      coin: "USDT",
      amount: 150_000,
      from: "Fiat and Spot",
      to: "Lead Trading Account",
      transType: "LEAD_DEPOSIT",
    };
    const positions = [{ symbol: "NVDAUSDT", direction: "LONG" as const, netQty: 3_206.99, avgOpenPrice: 162.749 }];

    const deposit = renderTransfer("熬鹰资本", base, positions);
    expect(deposit).toContain("持仓中补保证金");
    expect(deposit).toContain("他补保证金能扛");
    expect(deposit).toContain("NVDAUSDT 多 3,206.99");

    const withdraw = renderTransfer("熬鹰资本", { ...base, transType: "LEAD_WITHDRAW" }, positions);
    expect(withdraw).toContain("持仓中提取保证金");
    expect(withdraw).toContain("强平距离");

    const flat = renderTransfer("熬鹰资本", base, []);
    expect(flat).toContain("💸");
    expect(flat).not.toContain("持仓中");
  });

  it("信号带流动性评级和短线警告", () => {
    const order = sortedOrders().find((o) => o.symbol === "NVDAUSDT" && o.side === "BUY")!;
    const depth = {
      bids: [[162, 100] as [number, number], [161, 100] as [number, number]],
      asks: [[163, 100] as [number, number], [163.5, 100] as [number, number]],
    };
    const shortPositions = [1, 2, 3].map((index) => ({
      positionId: `p${index}`,
      symbol: "NVDAUSDT",
      side: "Long" as const,
      opened: 1_000_000,
      closed: 1_600_000,
      avgCost: 100,
      avgClosePrice: 101,
      closingPnl: 1,
      closedVolume: 1,
      leverage: 5,
      roi: 0.1,
      status: "All Closed",
    }));

    const signal = buildOrderSignal(
      order,
      { action: "open", direction: "LONG", netBefore: 0, netAfter: order.executedQty, avgOpenPrice: order.avgPrice, avgOpenBefore: null },
      {
        trader: { id: "aoying", portfolioId: "x", label: "熬鹰资本" },
        detail: loadDetail(),
        closedPositions: shortPositions,
        markPrice: 163,
        depth,
        detectedAt: order.orderUpdateTime,
      },
    );
    const text = renderOrderSignal(signal);
    expect(text).toContain("流动性 差");
    expect(text).toContain("0.1% 深度");
    expect(text).toContain("极短线");
  });
});
