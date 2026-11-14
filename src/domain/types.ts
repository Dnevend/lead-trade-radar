/**
 * 领域类型：只描述币安带单页的公开数据，不含任何 I/O。
 *
 * 口径来源见 docs/spec.md §2：字段名与站内接口一致，时间一律 UTC 毫秒。
 */

export type Side = "BUY" | "SELL";
export type PositionSide = "LONG" | "SHORT" | "BOTH";
export type Direction = "LONG" | "SHORT";

/** `lead-portfolio/order-history` 的一条已成交委托（不是成交明细）。 */
export interface LeadOrder {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  side: Side;
  positionSide: PositionSide;
  type: string;
  /** 该委托累计成交量（基础币数量）。 */
  executedQty: number;
  /** 该委托成交均价。 */
  avgPrice: number;
  /** 已实现盈亏；开/加仓为 0，减/平仓非 0。 */
  totalPnl: number;
  /** 下单时间。同一委托不变，用作幂等键的一部分。 */
  orderTime: number;
  /** 最后成交时间；用于增量窗口与排序。 */
  orderUpdateTime: number;
}

/** `lead-portfolio/position-history` 的一条已平仓位。 */
export interface ClosedPosition {
  positionId: string;
  symbol: string;
  /** 原始字段是 "Long" / "Short"。 */
  side: "Long" | "Short";
  opened: number;
  closed: number;
  avgCost: number;
  avgClosePrice: number;
  closingPnl: number;
  /** 平仓数量（币安按合约张数计，与 executedQty 口径不同）。 */
  closedVolume: number;
  leverage: number;
  roi: number;
  status: string;
}

/** `lead-portfolio/detail` 里本系统用到的字段。 */
export interface TraderDetail {
  leadPortfolioId: string;
  nickname: string;
  status: string;
  positionShow: boolean;
  marginBalance: number;
  aumAmount: number;
  lastTradeTime: number;
}

/** `lead-portfolio/transfer-history` 的一条资金划转。 */
export interface TransferRecord {
  time: number;
  coin: string;
  amount: number;
  from: string;
  to: string;
  transType: string;
}
