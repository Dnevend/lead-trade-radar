/**
 * 可跟性评估（docs/spec.md §6.1）：把「他做得到、你未必做得到」的部分量化。
 *
 * - 流动性：按他这笔的方向吃 0.1% 深度需要多少名义，和本单名义比。
 * - 持仓周期：同币种历史平仓的中位持有时间，低于 1 小时提示延迟风险。
 *
 * 纯函数，不碰 I/O。
 */

import type { ClosedPosition, LeadOrder } from "./types.ts";

export type DepthLevel = [price: number, qty: number];

export interface DepthSnapshot {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export type LiquidityLevel = "good" | "fair" | "poor";

export interface LiquidityAssessment {
  level: LiquidityLevel;
  /** 0.1% 价格带内的可成交名义（USD）。 */
  depthUsd: number;
  /** 本单名义 / 深度；>=1 表示他一个人吃掉整条带。 */
  share: number;
  bandPct: number;
}

/** 按订单方向评估 0.1% 深度：买看卖盘，卖看买盘。 */
export function assessLiquidity(
  notionalUsd: number,
  side: LeadOrder["side"],
  depth: DepthSnapshot | null,
  bandPct = 0.001,
): LiquidityAssessment | null {
  if (!depth || notionalUsd <= 0) {
    return null;
  }
  const levels = side === "BUY" ? depth.asks : depth.bids;
  const reference = levels[0]?.[0];
  if (reference === undefined || reference <= 0) {
    return null;
  }
  const limit = side === "BUY" ? reference * (1 + bandPct) : reference * (1 - bandPct);

  let depthUsd = 0;
  for (const [price, qty] of levels) {
    if (side === "BUY" ? price > limit : price < limit) {
      break;
    }
    depthUsd += price * qty;
  }
  if (depthUsd <= 0) {
    return null;
  }

  const share = notionalUsd / depthUsd;
  const level: LiquidityLevel = share < 0.1 ? "good" : share < 0.5 ? "fair" : "poor";
  return { level, depthUsd, share, bandPct };
}

/**
 * 同币种历史平仓的中位持有时间。样本少于 `minSamples` 时返回 null。
 * 只统计正常关闭的仓位，忽略异常记录。
 */
export function medianHoldingMs(records: ClosedPosition[], symbol: string, minSamples = 3): number | null {
  const durations = records
    .filter((record) => record.symbol === symbol && record.status === "All Closed" && record.closed > record.opened)
    .map((record) => record.closed - record.opened)
    .sort((a, b) => a - b);

  if (durations.length < minSamples) {
    return null;
  }
  const mid = Math.floor(durations.length / 2);
  return durations.length % 2 === 1
    ? durations[mid]!
    : Math.round((durations[mid - 1]! + durations[mid]!) / 2);
}
