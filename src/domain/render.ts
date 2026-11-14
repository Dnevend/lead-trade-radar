/**
 * Telegram 文案渲染（docs/spec.md §7）。纯字符串，不依赖 Telegram SDK。
 *
 * 用纯文本而非 HTML：带单员昵称里可能有任意字符，转义错误会让整条消息发送失败。
 */

import type { Action } from "./order.ts";
import type { OrderSignal } from "./signal.ts";
import type { Direction } from "./types.ts";
const TZ = "Asia/Shanghai";

const ACTION_ICON: Record<Action, string> = {
  open: "🟢",
  add: "➕",
  reduce: "➖",
  close: "✅",
};

const ACTION_TEXT: Record<Action, string> = {
  open: "开",
  add: "加",
  reduce: "减",
  close: "平",
};

export function renderOrderSignal(signal: OrderSignal): string {
  const { order, direction, action, trader } = signal;
  const dirText = direction === "LONG" ? "多" : "空";
  const lines: string[] = [];

  const header = `${ACTION_ICON[action]} ${trader.label} · ${ACTION_TEXT[action]}${dirText} ${order.symbol}`;
  lines.push(signal.averagingDown ? `⚠️ ${header}（摊平）` : header);

  if (action === "close" || order.totalPnl !== 0) {
    const priceText =
      signal.closedEntryPrice !== null && signal.closedExitPrice !== null
        ? `${fmtPrice(signal.closedEntryPrice)} → ${fmtPrice(signal.closedExitPrice)}`
        : `成交价 ${fmtPrice(order.avgPrice)}`;
    lines.push(`${fmtQty(order.executedQty)} ${order.baseAsset} · ${priceText}`);
    const pnl = fmtSignedUsd(order.totalPnl);
    const extras: string[] = [pnl];
    if (signal.leverage !== null) {
      extras.push(`${fmtNumber(signal.leverage)}x`);
    }
    if (signal.roi !== null) {
      extras.push(`ROI ${(signal.roi * 100).toFixed(1)}%`);
    }
    if (signal.holdingMs !== null) {
      extras.push(`持有 ${fmtDuration(signal.holdingMs)}`);
    }
    lines.push(extras.join(" · "));
    if (signal.avgOpenPrice !== null && signal.avgOpenPrice > 0) {
      lines.push(`本轮均价 ${fmtPrice(signal.avgOpenPrice)}`);
    }
  } else {
    lines.push(`均价 ${fmtPrice(order.avgPrice)} · ${fmtQty(order.executedQty)} ${order.baseAsset} · 名义 ${fmtUsd(signal.notionalUsd)}`);
    const extras: string[] = [];
    if (signal.marginRatio !== null) {
      extras.push(`≈ 他保证金 ${signal.marginRatio.toFixed(2)}×`);
    }
    if (signal.netAfter !== null) {
      extras.push(`推定持仓 ${fmtQty(signal.netAfter)}`);
    }
    if (extras.length > 0) {
      lines.push(extras.join(" · "));
    }
    if (action === "add" && signal.pnlPctBefore !== null && signal.markPrice !== null) {
      lines.push(`加仓前推定 ${fmtPct(signal.pnlPctBefore)} · 现价 ${fmtPrice(signal.markPrice)}`);
    }
  }

  if (signal.liquidity) {
    const label = signal.liquidity.level === "good" ? "好" : signal.liquidity.level === "fair" ? "一般" : "差";
    lines.push(
      `流动性 ${label} · 0.1% 深度 ${fmtUsd(signal.liquidity.depthUsd)} · 本单占 ${Math.round(signal.liquidity.share * 100)}%`,
    );
  }
  if ((action === "open" || action === "add") && signal.medianHoldMs !== null && signal.medianHoldMs < 3_600_000) {
    const veryShort = signal.medianHoldMs < 900_000;
    lines.push(
      `⚠️ ${veryShort ? "极短线" : "短线"}：该币历史中位持仓 ${fmtDuration(signal.medianHoldMs)}，手动跟单延迟会吃掉大部分`,
    );
  }

  const delaySec = Math.max(0, Math.round((signal.detectedAt - order.orderUpdateTime) / 1000));
  lines.push(`${fmtTime(order.orderUpdateTime)} · 延迟 ${delaySec}s`);
  return lines.join("\n");
}

export function fmtNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

export function fmtQty(value: number): string {
  if (!Number.isFinite(value)) {
    return "?";
  }
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return group(trimZeros(value.toFixed(digits)));
}

export function fmtPrice(value: number): string {
  if (!Number.isFinite(value)) {
    return "?";
  }
  const abs = Math.abs(value);
  if (abs >= 1000) {
    return group(value.toFixed(2));
  }
  const digits = abs >= 1 ? 4 : 6;
  return group(trimZeros(value.toFixed(digits)));
}

export function fmtUsd(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.round(Math.abs(value)).toLocaleString("en-US")}`;
}

export function fmtSignedUsd(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${Math.round(Math.abs(value)).toLocaleString("en-US")} USDT`;
}

export function fmtPct(value: number): string {
  const pct = value * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

export function fmtDuration(ms: number): string {  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) {
    return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

export function fmtTime(ms: number): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

/** 整数部分加千分位，小数部分原样保留。 */
function group(text: string): string {
  const [intPart, decimal] = text.split(".");
  const sign = intPart!.startsWith("-") ? "-" : "";
  const digitsOnly = sign ? intPart!.slice(1) : intPart!;
  const grouped = digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decimal === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${decimal}`;
}
