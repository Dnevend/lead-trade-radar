/**
 * 推定持仓账本（docs/spec.md §4）。
 *
 * 带单员可能隐藏持仓（positionShow=false），但订单流公开。账本从「最近一次全平」
 * 这个锚点开始，把订单按加/减累加，得到当前推定持仓。没有锚点时标记 unknown，
 * 只报告单笔方向，不报告总量。
 *
 * 纯函数 + 显式状态，便于回放测试。
 */

import { actionOf, isZero, meaningOf, type Action } from "./order.ts";
import type { ClosedPosition, Direction, LeadOrder } from "./types.ts";

export interface LedgerState {
  symbol: string;
  direction: Direction;
  /** 推定净持仓（基础币数量，按方向取正）。 */
  netQty: number;
  /** 本轮（自上次清零）加仓的成交量加权均价。 */
  avgOpenPrice: number;
  /** 本轮累计加仓数量，用于算均价。 */
  openedQty: number;
  /** 是否有订单早于可回溯窗口；true 时 netQty 不可信。 */
  unknownBaseline: boolean;
  /** 最近一次全平的时间锚点；0 表示没有。 */
  anchorClosedAt: number;
  /** 已应用到该账本的最新订单时间，用于防止迟到的锚点抹掉新仓位。 */
  lastOrderAt: number;
  /** 最近一次加仓订单时间，用于识别「同毫秒平仓后反手」。 */
  lastIncreaseAt: number;
}

export interface LedgerTransition {
  state: LedgerState;
  action: Action;
  direction: Direction;
  /** 下单前持仓；无锚点时是 null。 */
  netBefore: number | null;
  /** 下单后持仓；无锚点为 null。 */
  netAfter: number | null;
  /** 下单后本轮均价；无持仓时 null。 */
  avgOpenPrice: number | null;
  /** 下单前的本轮均价；用于判断这笔加仓是浮盈加仓还是摊平。 */
  avgOpenBefore: number | null;
}

export type Ledger = Map<string, LedgerState>;

export function ledgerKey(symbol: string, direction: Direction): string {
  return `${symbol}|${direction}`;
}

export function createLedger(): Ledger {
  return new Map();
}

/** 在指定时间点标记「已知空仓」，供回放/测试使用；生产由 position-history 锚点提供。 */
export function seedFlat(ledger: Ledger, symbol: string, direction: Direction, at = 0): void {
  ledger.set(ledgerKey(symbol, direction), {
    symbol,
    direction,
    netQty: 0,
    avgOpenPrice: 0,
    openedQty: 0,
    unknownBaseline: false,
    anchorClosedAt: at,
    lastOrderAt: at,
    lastIncreaseAt: 0,
  });
}

export function getState(ledger: Ledger, symbol: string, direction: Direction): LedgerState | undefined {
  return ledger.get(ledgerKey(symbol, direction));
}

/**
 * 用一条平仓记录校准锚点：该仓位已全部平掉，净持仓归零。
 *
 * 校准条件：记录比上次锚点新，且不早于已应用的最后一笔订单。
 * 「新于最后一笔订单」保证同一轮里「平仓记录 + 平仓订单」不会把订单重复扣一次；
 * 同时允许已知账本在漏单/漂移后用平仓记录自愈。
 */
export function applyAnchor(ledger: Ledger, closed: ClosedPosition): void {
  const direction: Direction = closed.side === "Long" ? "LONG" : "SHORT";
  const key = ledgerKey(closed.symbol, direction);
  const current = ledger.get(key);

  if (!current) {
    ledger.set(key, {
      symbol: closed.symbol,
      direction,
      netQty: 0,
      avgOpenPrice: 0,
      openedQty: 0,
      unknownBaseline: false,
      anchorClosedAt: closed.closed,
      lastOrderAt: 0,
      lastIncreaseAt: 0,
    });
    return;
  }

  if (current.anchorClosedAt >= closed.closed) {
    return;
  }
  // 锚点之后我们已经应用过新订单（可能是反手开的新仓）→ 不能清零。
  if (current.lastOrderAt > closed.closed) {
    return;
  }
  // 同一毫秒平仓后立刻反手：锚点等于加仓时间时也不能清零。
  if (current.lastIncreaseAt >= closed.closed) {
    return;
  }

  current.netQty = 0;
  current.avgOpenPrice = 0;
  current.openedQty = 0;
  current.unknownBaseline = false;
  current.anchorClosedAt = closed.closed;
}

/**
 * 应用一笔订单。锚点晚于该订单时不改账本（订单属于上一轮仓位），只返回方向。
 */
export function applyOrder(ledger: Ledger, order: LeadOrder): LedgerTransition {
  const meaning = meaningOf(order);
  const key = ledgerKey(order.symbol, meaning.direction);
  const existing = ledger.get(key);
  const state: LedgerState = existing ?? {
    symbol: order.symbol,
    direction: meaning.direction,
    netQty: 0,
    avgOpenPrice: 0,
    openedQty: 0,
    unknownBaseline: true,
    anchorClosedAt: 0,
    lastOrderAt: 0,
    lastIncreaseAt: 0,
  };

  // 该订单早于锚点：属于上一轮仓位，不参与本轮累计。
  // 但「同一毫秒的加仓」要放行——那是平仓后立刻反手开的新仓。
  const atAnchor = order.orderUpdateTime === state.anchorClosedAt;
  const beforeAnchor = order.orderUpdateTime < state.anchorClosedAt;
  if (state.anchorClosedAt > 0 && (beforeAnchor || (atAnchor && !meaning.increase))) {
    const finalClose = !meaning.increase && atAnchor;
    return {
      state,
      action: meaning.increase ? "add" : finalClose ? "close" : "reduce",
      direction: meaning.direction,
      netBefore: null,
      netAfter: null,
      avgOpenPrice: null,
      avgOpenBefore: null,
    };
  }

  const netBefore = state.unknownBaseline ? null : state.netQty;
  const avgOpenBefore = state.unknownBaseline || isZero(state.netQty) ? null : state.avgOpenPrice;
  const next: LedgerState = { ...state };
  next.lastOrderAt = Math.max(next.lastOrderAt, order.orderUpdateTime);
  if (meaning.increase) {
    next.lastIncreaseAt = Math.max(next.lastIncreaseAt, order.orderUpdateTime);
  }

  if (meaning.increase) {
    if (isZero(next.netQty)) {
      next.avgOpenPrice = order.avgPrice;
      next.openedQty = order.executedQty;
    } else {
      const totalNotional = next.avgOpenPrice * next.openedQty + order.avgPrice * order.executedQty;
      next.openedQty += order.executedQty;
      next.avgOpenPrice = next.openedQty > 0 ? totalNotional / next.openedQty : 0;
    }
    next.netQty += order.executedQty;
  } else {
    const after = next.netQty - order.executedQty;
    if (after < -1e-9) {
      // 减仓量超过账本累计：可能是基线未知，也可能是漏过一笔减仓。
      // 若这条减仓订单与锚点几乎同刻，说明它就是那次全平的收尾，直接归零。
      const anchoredNow =
        state.anchorClosedAt > 0 && Math.abs(state.anchorClosedAt - order.orderUpdateTime) <= 2_000;
      next.netQty = 0;
      next.avgOpenPrice = 0;
      next.openedQty = 0;
      if (!anchoredNow) {
        next.unknownBaseline = true;
      }
    } else {
      next.netQty = after;
      if (isZero(next.netQty)) {
        next.avgOpenPrice = 0;
        next.openedQty = 0;
      }
    }
  }

  ledger.set(key, next);

  const netAfter = next.unknownBaseline ? null : next.netQty;
  return {
    state: next,
    action: actionOf(meaning, netBefore, netAfter),
    direction: meaning.direction,
    netBefore,
    netAfter,
    avgOpenPrice: isZero(next.netQty) ? null : next.avgOpenPrice,
    avgOpenBefore,
  };
}
