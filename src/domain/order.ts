/**
 * 订单分类纯函数（docs/spec.md §3）。
 *
 * 币安带单账户用双向持仓：`side` + `positionSide` 就能断定是加仓还是减仓。
 * 单向持仓（positionSide=BOTH）只能靠 `totalPnl` 区分：开仓为 0，平仓非 0。
 */

import type { Direction, LeadOrder, PositionSide } from "./types.ts";

export type Action = "open" | "add" | "reduce" | "close";

export interface OrderMeaning {
  direction: Direction;
  /** true = 加仓方向（买多 / 卖空）。 */
  increase: boolean;
  /** 该订单的带符号数量：加仓为正，减仓为负。 */
  signedQty: number;
}

/**
 * 委托身份：同一委托的 `orderTime` 稳定，但没有 orderId。
 * 同一毫秒下可能有多笔独立委托（实测 ETH 平仓有 3 笔同毫秒），所以
 * 只用前 4 段做「可能同一委托」的归组，最终身份仍要带数量与均价。
 */
export function orderBaseKey(order: LeadOrder): string {
  return [order.symbol, order.side, order.positionSide, order.orderTime].join("|");
}

/**
 * 幂等键：订单没有 orderId，只能用指纹（§5）。
 * 包含数量与均价：同一委托如果后续继续成交，会作为一笔“补量”再报一次，
 * 这样既不会漏掉加仓，也不会把已经报过的成交重复报。
 */
export function orderDedupeKey(order: LeadOrder): string {
  return [orderBaseKey(order), order.executedQty, order.avgPrice].join("|");
}

export function meaningOf(order: LeadOrder): OrderMeaning {
  const direction = directionOf(order.positionSide, order.side, order.totalPnl);
  const increase =
    order.positionSide === "BOTH"
      ? order.totalPnl === 0
      : (order.side === "BUY") === (order.positionSide === "LONG");
  return {
    direction,
    increase,
    signedQty: increase ? order.executedQty : -order.executedQty,
  };
}

function directionOf(positionSide: PositionSide, side: LeadOrder["side"], totalPnl: number): Direction {
  if (positionSide !== "BOTH") {
    return positionSide;
  }
  // 单向持仓：BUY 且无已实现盈亏 = 开多；有盈亏 = 平空。SELL 反之。
  if (side === "BUY") {
    return totalPnl === 0 ? "LONG" : "SHORT";
  }
  return totalPnl === 0 ? "SHORT" : "LONG";
}

/**
 * 结合账本判断这一笔是开、加、减还是全平。
 * `netBefore` / `netAfter` 是该 (symbol, direction) 的持仓量，未知可为 null。
 */
export function actionOf(meaning: OrderMeaning, netBefore: number | null, netAfter: number | null): Action {
  if (meaning.increase) {
    if (netBefore !== null && isZero(netBefore)) {
      return "open";
    }
    return "add";
  }
  if (netAfter !== null && isZero(netAfter)) {
    return "close";
  }
  return "reduce";
}

export function isZero(value: number): boolean {
  return Math.abs(value) < 1e-9;
}
