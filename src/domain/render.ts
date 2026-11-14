/**
 * Telegram 文案渲染（docs/spec.md §7）。纯字符串，不依赖 Telegram SDK。
 *
 * 用纯文本而非 HTML：带单员昵称里可能有任意字符，转义错误会让整条消息发送失败。
 */

import type { Action } from "./order.ts";
import type { OrderSignal } from "./signal.ts";
import type { Tweet, TweetMedia } from "./tweet.ts";
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

export interface RenderedTweetDigest {
  text: string;
  /** 这条消息包含的推文，用于生成稳定的去重键。 */
  tweets: Tweet[];
}

/**
 * X 推文摘要（docs/spec.md §7.1）：多条合并成一条消息，按推文边界拆分成多条。
 * 单条推文超长时只截断正文，时间和原链接一定保留。
 */
export function renderTweetDigest(params: {
  label: string;
  handle: string;
  tweets: Tweet[];
  /** Telegram 单条上限 4096；默认留出安全余量。 */
  maxLength?: number;
}): RenderedTweetDigest[] {
  const { label, handle, tweets } = params;
  if (tweets.length === 0) {
    return [];
  }
  const limit = params.maxLength ?? 3800;
  // 预留标题长度，避免拼接后超过 Telegram 上限。
  const budget = limit - 80;
  const blocks = tweets.map((tweet) => renderTweetBlock(tweet, budget));

  const chunks: Array<{ tweets: Tweet[]; blocks: string[] }> = [];
  let current: { tweets: Tweet[]; blocks: string[] } = { tweets: [], blocks: [] };
  let currentLength = 0;
  for (let index = 0; index < tweets.length; index += 1) {
    const block = blocks[index]!;
    const extra = current.blocks.length === 0 ? block.length : block.length + 2;
    if (current.blocks.length > 0 && currentLength + extra > budget) {
      chunks.push(current);
      current = { tweets: [], blocks: [] };
      currentLength = 0;
    }
    current.tweets.push(tweets[index]!);
    current.blocks.push(block);
    currentLength += current.blocks.length === 1 ? block.length : block.length + 2;
  }
  if (current.blocks.length > 0) {
    chunks.push(current);
  }

  return chunks.map((chunk, index) => {
    const header =
      chunks.length === 1
        ? `🐦 ${label} · @${handle} 新推文 ${tweets.length} 条`
        : `🐦 ${label} · @${handle} 新推文（${index + 1}/${chunks.length}）`;
    return { text: `${header}\n\n${chunk.blocks.join("\n\n")}`, tweets: chunk.tweets };
  });
}

function renderTweetBlock(tweet: Tweet, maxLength?: number): string {
  const time = fmtTime(tweet.createdAt);
  const media = mediaLabel(tweet.media);
  const text = tweet.text.trim();
  const fixed = [time, media, tweet.url].filter((line) => line.length > 0).join("\n");

  if (maxLength !== undefined && fixed.length + 2 + text.length > maxLength) {
    const textBudget = Math.max(20, maxLength - fixed.length - 2);
    return [time, truncate(text, textBudget), media, tweet.url].filter((line) => line.length > 0).join("\n");
  }
  return [time, text, media, tweet.url].filter((line) => line.length > 0).join("\n");
}

function mediaLabel(media: TweetMedia[]): string {
  if (media.length === 0) {
    return "";
  }
  if (media.some((item) => item.type === "video" || item.type === "gif" || item.type === "animated_gif")) {
    return "（含视频）";
  }
  return `（${media.length} 张图）`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  let cut = text.slice(0, Math.max(0, maxLength - 1));
  // 不要把 emoji 的代理对切成两半。
  if (/[\uD800-\uDBFF]$/.test(cut)) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
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
