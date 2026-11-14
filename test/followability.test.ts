import { describe, expect, it } from "vitest";
import { assessLiquidity, medianHoldingMs } from "../src/domain/followability.ts";
import type { ClosedPosition } from "../src/domain/types.ts";

describe("可跟性评估", () => {
  it("按方向取对手盘，0.1% 带内累计名义", () => {
    const depth = {
      bids: [
        [100, 10] as [number, number],
        [99.95, 20] as [number, number],
        [99.8, 100] as [number, number],
      ],
      asks: [
        [100.1, 10] as [number, number],
        [100.15, 20] as [number, number],
        [100.3, 100] as [number, number],
      ],
    };

    const buy = assessLiquidity(100, "BUY", depth)!;
    // 100.1*10 + 100.15*20 = 1001 + 2003 = 3004
    expect(buy.depthUsd).toBeCloseTo(3_004, 6);
    expect(buy.level).toBe("good");

    const medium = assessLiquidity(1_000, "BUY", depth)!;
    expect(medium.level).toBe("fair");

    const bigBuy = assessLiquidity(30_000, "BUY", depth)!;
    expect(bigBuy.level).toBe("poor");
  });

  it("盘口为空或名义为 0 时返回 null", () => {
    expect(assessLiquidity(1_000, "BUY", null)).toBeNull();
    expect(assessLiquidity(0, "BUY", { bids: [[1, 1]], asks: [[1.1, 1]] })).toBeNull();
    expect(assessLiquidity(1_000, "BUY", { bids: [[1, 1]], asks: [] })).toBeNull();
  });

  it("中位持仓：样本不足返回 null，奇偶都取中位", () => {
    const make = (minutes: number, index: number): ClosedPosition => ({
      positionId: `p${index}`,
      symbol: "BTCUSDT",
      side: "Long",
      opened: 0,
      closed: minutes * 60_000,
      avgCost: 1,
      avgClosePrice: 1,
      closingPnl: 0,
      closedVolume: 1,
      leverage: 1,
      roi: 0,
      status: "All Closed",
    });

    expect(medianHoldingMs([make(5, 1), make(6, 2)], "BTCUSDT")).toBeNull();
    expect(medianHoldingMs([make(5, 1), make(6, 2), make(100, 3)], "BTCUSDT")).toBe(6 * 60_000);
    expect(medianHoldingMs([make(5, 1), make(6, 2), make(7, 3), make(100, 4)], "BTCUSDT")).toBe(6.5 * 60_000);
    expect(medianHoldingMs([make(5, 1)], "ETHUSDT")).toBeNull();
  });
});
