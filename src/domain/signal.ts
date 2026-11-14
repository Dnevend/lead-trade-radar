/**
 * 信号组装（docs/spec.md §6）：把「一笔订单 + 账本迁移 + 平仓记录」拼成一条待推送信号。
 * 只做计算，不渲染、不入库。
 */

import type { Action } from "./order.ts";
import { assessLiquidity, medianHoldingMs, type DepthSnapshot, type LiquidityAssessment } from "./followability.ts";
import type { ClosedPosition, Direction, LeadOrder, TraderDetail } from "./types.ts";

export interface TraderRef {
  id: string;
  portfolioId: string;
  label: string;
}

export interface OrderSignal {
  kind: "order";
  trader: TraderRef;
  order: LeadOrder;
  action: Action;
  direction: Direction;
  /** 下单前推定持仓；账本未知时 null。 */
  netBefore: number | null;
  netAfter: number | null;
  avgOpenPrice: number | null;
  notionalUsd: number;
  /** 名义额 / 带单员保证金余额；拿不到保证金时 null。 */
  marginRatio: number | null;
  /** 现价；拉不到时为 null。 */
  markPrice: number | null;
  /** 加仓前相对本轮均价的价格变动（多空同号：负数=浮亏）。 */
  pnlPctBefore: number | null;
  /** 浮亏状态下加仓（摊平）。 */
  averagingDown: boolean;
  /** 0.1% 深度评估；拉不到盘口时为 null。 */
  liquidity: LiquidityAssessment | null;
  /** 同币种历史中位持仓；样本不足时 null。 */
  medianHoldMs: number | null;
  leverage: number | null;
  roi: number | null;
  holdingMs: number | null;
  /** 匹配到的平仓记录上的开仓均价 / 平仓均价；没有记录时 null。 */
  closedEntryPrice: number | null;
  closedExitPrice: number | null;
  detectedAt: number;
}

export interface SignalContext {
  trader: TraderRef;
  detail: TraderDetail | null;
  closedPositions: ClosedPosition[];
  markPrice: number | null;
  depth: DepthSnapshot | null;
  detectedAt: number;
}

export function buildOrderSignal(
  order: LeadOrder,
  transition: {
    action: Action;
    direction: Direction;
    netBefore: number | null;
    netAfter: number | null;
    avgOpenPrice: number | null;
    avgOpenBefore: number | null;
  },
  ctx: SignalContext,
): OrderSignal {
  const notionalUsd = order.executedQty * order.avgPrice;
  const margin = ctx.detail?.marginBalance ?? null;
  const closed = matchClosedPosition(ctx.closedPositions, order, transition.direction);

  // 加仓前相对本轮均价的变动：负数=浮亏；多空方向统一成「赚为正」。
  const avgBefore = transition.avgOpenBefore;
  const pnlPctBefore =
    avgBefore !== null && avgBefore > 0 && ctx.markPrice !== null
      ? transition.direction === "LONG"
        ? (ctx.markPrice - avgBefore) / avgBefore
        : (avgBefore - ctx.markPrice) / avgBefore
      : null;

  const liquidity = assessLiquidity(notionalUsd, order.side, ctx.depth);
  const medianHoldMs = medianHoldingMs(ctx.closedPositions, order.symbol);

  return {
    kind: "order",
    trader: ctx.trader,
    order,
    action: transition.action,
    direction: transition.direction,
    netBefore: transition.netBefore,
    netAfter: transition.netAfter,
    avgOpenPrice: transition.avgOpenPrice,
    notionalUsd,
    marginRatio: margin !== null && margin > 0 ? notionalUsd / margin : null,
    markPrice: ctx.markPrice,
    pnlPctBefore,
    averagingDown: transition.action === "add" && pnlPctBefore !== null && pnlPctBefore <= -0.05,
    liquidity,
    medianHoldMs,
    leverage: closed?.leverage ?? null,
    roi: closed?.roi ?? null,
    holdingMs: closed ? closed.closed - closed.opened : null,
    closedEntryPrice: closed?.avgCost ?? null,
    closedExitPrice: closed?.avgClosePrice ?? null,
    detectedAt: ctx.detectedAt,
  };
}

/**
 * 把减仓订单和已平仓位记录对上（§6.3）。
 * 币安两者时间戳实测毫秒级一致；这里留 2 分钟容差，按时间差取最近一条。
 * 一个仓位分多笔平掉时，多笔订单会匹配到同一条记录，各自仍只显示自己的已实现盈亏。
 */
export function matchClosedPosition(
  closedPositions: ClosedPosition[],
  order: LeadOrder,
  direction: Direction,
): ClosedPosition | null {
  const wantSide = direction === "LONG" ? "Long" : "Short";
  let best: ClosedPosition | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const record of closedPositions) {
    if (record.symbol !== order.symbol || record.side !== wantSide) {
      continue;
    }
    const delta = Math.abs(record.closed - order.orderUpdateTime);
    if (delta <= 120_000 && delta < bestDelta) {
      best = record;
      bestDelta = delta;
    }
  }
  return best;
}
