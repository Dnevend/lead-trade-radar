/**
 * 单个带单员的轮询编排（docs/spec.md §5–§9）。
 *
 * 一轮：detail / 平仓记录 / 订单增量 → 账本 → 信号入库 → 发 outbox。
 * 任何一步失败都不推进 lastSeen，下一轮会重新覆盖同一窗口，不会漏单。
 */

import type { BapiClient } from "../adapters/binance/bapi.ts";
import type { Store } from "../adapters/sqlite/store.ts";
import { TelegramError } from "../adapters/telegram/client.ts";
import type { TraderConfig } from "../config/config.ts";
import { applyAnchor, applyOrder, createLedger, type Ledger } from "../domain/ledger.ts";
import { orderBaseKey, orderDedupeKey } from "../domain/order.ts";
import { renderOrderSignal } from "../domain/render.ts";
import { buildOrderSignal, type TraderRef } from "../domain/signal.ts";
import type { ClosedPosition, LeadOrder, TraderDetail, TransferRecord } from "../domain/types.ts";
import type { DepthSnapshot } from "../domain/followability.ts";

export interface Notifier {
  sendMessage(text: string): Promise<{ messageId: number | null }>;
}

export interface RunnerDeps {
  store: Store;
  client: BapiClient;
  notifier: Notifier | null;
  push: boolean;
  bootstrapDays: number;
  now: () => number;
  log: (message: string, extra?: Record<string, unknown>) => void;
  /** 现价；只用于「摊平/浮亏」提示，失败不影响信号。 */
  priceOf?: (symbol: string) => Promise<number | null>;
  /** 盘口深度；只用于流动性提示，失败不影响信号。 */
  depthOf?: (symbol: string) => Promise<DepthSnapshot | null>;
}

const OVERLAP_MS = 120_000;
const BOOTSTRAP_SILENT = -1;

export class TraderRunner {
  readonly ref: TraderRef;
  private readonly trader: TraderConfig;
  private lastDetail: TraderDetail | null = null;
  private lastStatus: string | null = null;
  private lastPushError: string | null = null;

  constructor(
    private readonly deps: RunnerDeps,
    trader: TraderConfig,
  ) {
    this.trader = trader;
    this.ref = { id: trader.id, portfolioId: trader.portfolioId, label: trader.label };
  }

  /** 首次启动：回补历史订单建账本，静默入库，不推送。 */
  async bootstrapIfNeeded(): Promise<void> {
    const { store, client, now, log } = this.deps;
    const existing = store.getTrader(this.trader.id);
    if (existing?.bootstrapDone && existing.portfolioId === this.trader.portfolioId) {
      return;
    }

    const startedAt = now();
    log("bootstrap 开始", { trader: this.trader.id, days: this.deps.bootstrapDays });

    const detail = await client.fetchDetail(this.trader.portfolioId);
    this.lastDetail = detail;
    this.lastStatus = detail.status;

    const closed = await client.fetchClosedPositions(this.trader.portfolioId, 3);
    store.upsertClosedPositions(this.trader.id, closed);
    log("bootstrap 平仓记录", { trader: this.trader.id, count: closed.length });

    const ledger = createLedger();
    for (const record of [...closed].sort((a, b) => a.closed - b.closed)) {
      applyAnchor(ledger, record);
    }

    const start = startedAt - this.deps.bootstrapDays * 86_400_000;
    const orders = await client.fetchOrders(this.trader.portfolioId, start, startedAt);
    const sorted = [...orders].sort((a, b) => a.orderUpdateTime - b.orderUpdateTime || a.orderTime - b.orderTime);
    store.transaction(() => {
      for (const order of sorted) {
        store.insertOrder(this.trader.id, orderDedupeKey(order), order, BOOTSTRAP_SILENT);
        applyOrder(ledger, order);
        store.putOrderSnapshot(this.trader.id, orderBaseKey(order), {
          fingerprint: orderDedupeKey(order),
          executedQty: order.executedQty,
          avgPrice: order.avgPrice,
          totalPnl: order.totalPnl,
        });
      }
      store.saveLedger(this.trader.id, ledger);
    });

    // 历史资金划转静默入库，避免首轮刷屏。
    const transfers = await client.fetchTransfers(this.trader.portfolioId).catch(() => [] as TransferRecord[]);
    for (const transfer of transfers) {
      store.insertSignal({
        traderId: this.trader.id,
        dedupeKey: transferKey(transfer),
        action: "transfer",
        text: renderTransfer(this.trader.label, transfer),
        createdAt: transfer.time,
        sentAt: transfer.time,
        messageId: null,
      });
    }

    const lastSeen = sorted.length > 0 ? Math.max(...sorted.map((o) => o.orderUpdateTime)) : startedAt - 60_000;
    store.upsertTrader({
      id: this.trader.id,
      portfolioId: this.trader.portfolioId,
      label: this.trader.label,
      lastSeenMs: lastSeen,
      bootstrapDone: true,
      disabledReason: null,
    });
    log("bootstrap 完成", { trader: this.trader.id, orders: sorted.length, lastSeen });
  }

  /** 跑一轮，返回本轮新产生的信号文本（便于 CLI 预览）。 */
  async cycle(): Promise<string[]> {
    const { store, client, now, log, push, notifier } = this.deps;
    const traderId = this.trader.id;
    const emitted: string[] = [];

    const trader = store.getTrader(traderId);
    if (!trader?.bootstrapDone) {
      throw new Error(`交易员 ${traderId} 还没 bootstrap`);
    }

    const detail = await client.fetchDetail(this.trader.portfolioId);
    this.lastDetail = detail;
    if (this.lastStatus !== null && this.lastStatus !== detail.status) {
      this.emitAlert(`⚠️ ${this.trader.label} 状态变化：${this.lastStatus} → ${detail.status}`, `status|${detail.status}`);
    }
    this.lastStatus = detail.status;

    const closed = await client.fetchClosedPositions(this.trader.portfolioId, 2);
    store.upsertClosedPositions(traderId, closed);
    const recentClosed = store.listClosedPositions(traderId, 100);

    const ledger = store.loadLedger(traderId);

    const detectedAt = now();
    const orders = await client.fetchOrders(this.trader.portfolioId, trader.lastSeenMs - OVERLAP_MS, detectedAt);
    const fresh = orders
      .filter((order) => !store.hasOrder(traderId, orderDedupeKey(order)))
      .sort((a, b) => a.orderUpdateTime - b.orderUpdateTime || a.orderTime - b.orderTime);

    // 按归组键分组：同一毫秒可能有多笔独立委托，补量必须按「组内哪一笔旧快照消失了」判断。
    const groups = new Map<string, LeadOrder[]>();
    for (const order of orders) {
      const base = orderBaseKey(order);
      const list = groups.get(base);
      if (list) {
        list.push(order);
      } else {
        groups.set(base, [order]);
      }
    }
    const freshKeys = new Set(fresh.map((order) => orderDedupeKey(order)));

    // 现价与盘口只用于「摊平 / 流动性 / 短线」提示；拿不到就不显示，不阻塞信号。
    const prices = new Map<string, number>();
    const depths = new Map<string, DepthSnapshot>();
    if (fresh.length > 0) {
      const symbols = [...new Set(fresh.map((order) => order.symbol))];
      await Promise.all(
        symbols.map(async (symbol) => {
          if (this.deps.priceOf) {
            try {
              const price = await this.deps.priceOf(symbol);
              if (price !== null && Number.isFinite(price) && price > 0) {
                prices.set(symbol, price);
              }
            } catch {
              // 忽略
            }
          }
          if (this.deps.depthOf) {
            try {
              const depth = await this.deps.depthOf(symbol);
              if (depth) {
                depths.set(symbol, depth);
              }
            } catch {
              // 忽略
            }
          }
        }),
      );
    }

    store.transaction(() => {
      for (const [base, group] of groups) {
        const groupFresh = group.filter((order) => freshKeys.has(orderDedupeKey(order)));
        if (groupFresh.length === 0) {
          continue;
        }

        const snapshots = store.listOrderSnapshots(traderId, base);
        const groupKeys = new Set(group.map((order) => orderDedupeKey(order)));
        // 本轮消失的旧快照 = 候选的「同一委托补量」。
        const missing = snapshots.filter((snapshot) => !groupKeys.has(snapshot.fingerprint));
        const grownFrom =
          group.length === snapshots.length && groupFresh.length === 1 && missing.length === 1
            ? missing[0]!
            : null;

        for (const order of groupFresh) {
          let applied = order;
          let deltaQty = order.executedQty;

          if (grownFrom) {
            deltaQty = order.executedQty - grownFrom.executedQty;
            if (deltaQty > 1e-9) {
              const deltaNotional = order.executedQty * order.avgPrice - grownFrom.executedQty * grownFrom.avgPrice;
              applied = {
                ...order,
                executedQty: deltaQty,
                avgPrice: deltaNotional / deltaQty,
                totalPnl: order.totalPnl - grownFrom.totalPnl,
              };
            }
          }

          if (deltaQty > 1e-9) {
            const transition = applyOrder(ledger, applied);
            const signal = buildOrderSignal(applied, transition, {
              trader: this.ref,
              detail: this.lastDetail,
              closedPositions: recentClosed,
              markPrice: prices.get(order.symbol) ?? null,
              depth: depths.get(order.symbol) ?? null,
              detectedAt,
            });
            const text = renderOrderSignal(signal);
            // 先写 outbox 再写订单：即使进程在两条写入之间被杀，事务回滚后下一轮会重做。
            const inserted = store.insertSignal({
              traderId,
              dedupeKey: orderDedupeKey(order),
              action: signal.action,
              text,
              createdAt: detectedAt,
              // shadow 模式下标记成“已处理”，避免将来打开推送时把历史信号一次性补发。
              sentAt: push ? null : detectedAt,
              messageId: null,
            });
            if (inserted) {
              emitted.push(text);
              log("signal", { trader: traderId, action: signal.action, symbol: order.symbol, qty: deltaQty });
            }
          }

          store.insertOrder(traderId, orderDedupeKey(order), order, detectedAt);
          if (grownFrom) {
            store.deleteOrderSnapshot(traderId, grownFrom.fingerprint);
          }
          store.putOrderSnapshot(traderId, base, {
            fingerprint: orderDedupeKey(order),
            executedQty: order.executedQty,
            avgPrice: order.avgPrice,
            totalPnl: order.totalPnl,
          });
        }

        // 升级前已在 lead_order、但还没有快照的订单补一份，下一轮才不会误判成补量。
        for (const order of group) {
          const key = orderDedupeKey(order);
          if (freshKeys.has(key)) continue;
          if (snapshots.some((snapshot) => snapshot.fingerprint === key)) continue;
          store.putOrderSnapshot(traderId, base, {
            fingerprint: key,
            executedQty: order.executedQty,
            avgPrice: order.avgPrice,
            totalPnl: order.totalPnl,
          });
        }
      }
      // 订单先应用、锚点后校准：同一轮里平仓订单不会被锚点提前抹掉，
      // 漏单造成的漂移也能被同轮的平仓记录修正。
      for (const record of [...closed].sort((a, b) => a.closed - b.closed)) {
        applyAnchor(ledger, record);
      }
      store.saveLedger(traderId, ledger);
    });

    // 资金划转（提现/入金）也是风险信号；拉取失败不影响订单信号。
    const transfers = await client.fetchTransfers(this.trader.portfolioId).catch(() => [] as TransferRecord[]);
    const openPositions: PositionSummary[] = [...ledger.values()]
      .filter((state) => Math.abs(state.netQty) > 1e-6)
      .map((state) => ({
        symbol: state.symbol,
        direction: state.direction,
        netQty: state.netQty,
        avgOpenPrice: state.avgOpenPrice,
      }));
    store.transaction(() => {
      for (const transfer of transfers) {
        const key = transferKey(transfer);
        const text = renderTransfer(this.trader.label, transfer, openPositions);
        if (
          store.insertSignal({
            traderId,
            dedupeKey: key,
            action: "transfer",
            text,
            createdAt: detectedAt,
            sentAt: push ? null : detectedAt,
            messageId: null,
          })
        ) {
          emitted.push(text);
        }
      }
    });

    if (orders.length > 0) {
      const lastSeen = Math.max(trader.lastSeenMs, ...orders.map((o) => o.orderUpdateTime));
      store.upsertTrader({ ...trader, lastSeenMs: lastSeen });
    }

    if (push && notifier) {
      await this.flushOutbox();
    }

    store.setHealth({ traderId, failures: 0, lastOkAt: now(), lastError: this.lastPushError });
    return emitted;
  }

  /** 带单项目关闭等永久故障：停止监控并确保告警只发一次。 */
  async disable(reason: string): Promise<void> {
    const { store, log, push, notifier } = this.deps;
    const health = store.getHealth(this.trader.id);
    store.setHealth({
      traderId: this.trader.id,
      failures: health.failures,
      lastOkAt: health.lastOkAt,
      lastError: reason,
    });
    store.setTraderDisabled(this.trader.id, reason);
    // 稳定键：重启后重复 insert 会被忽略，不会每 5 秒刷一条告警。
    this.emitAlert(`🛑 ${this.trader.label} 已停止监控：${reason}`, "disabled");
    log("停止监控", { trader: this.trader.id, reason });
    if (push && notifier) {
      await this.flushOutbox();
    }
  }

  /** 发件箱：把所有尚未发送的信号补发出去；失败的下轮再试。 */
  async flushOutbox(): Promise<void> {
    const { store, notifier, now, log } = this.deps;
    if (!notifier) {
      return;
    }
    const pending = store.listPendingSignals(50);
    for (const row of pending) {
      try {
        const result = await notifier.sendMessage(row.text);
        store.markSent(row.traderId, row.dedupeKey, now(), result.messageId);
        this.lastPushError = null;
      } catch (error) {
        this.lastPushError = String(error);
        if (error instanceof TelegramError && error.permanent) {
          // 永久错误（chat_id 错、被踢、文本超长）不能堵住队列：丢弃并继续。
          store.markDropped(row.traderId, row.dedupeKey);
          log("永久发送失败，已跳过", { trader: row.traderId, error: String(error) });
          continue;
        }
        log("发送失败，留在 outbox", { trader: row.traderId, error: String(error) });
        break;
      }
    }
  }

  private emitAlert(text: string, key: string): void {
    const { store, now, push } = this.deps;
    const at = now();
    store.insertSignal({
      traderId: this.trader.id,
      dedupeKey: `alert|${key}`,
      action: "alert",
      text,
      createdAt: at,
      sentAt: push ? null : at,
      messageId: null,
    });
  }

  /** 轮询失败时调用：累计失败次数，连续 3 次发一次告警，并把 outbox 里积压的消息发掉。 */
  async reportFailure(error: unknown): Promise<void> {
    const { store, now, log } = this.deps;
    const health = store.getHealth(this.trader.id);
    const failures = health.failures + 1;
    store.setHealth({
      traderId: this.trader.id,
      failures,
      lastOkAt: health.lastOkAt,
      lastError: String(error),
    });
    log("轮询失败", { trader: this.trader.id, failures, error: String(error) });
    if (failures === 3) {
      this.emitAlert(
        `⚠️ ${this.trader.label} 连续 3 次拉取失败，信号可能中断\n${String(error).slice(0, 200)}`,
        `health|${now()}`,
      );
    }
    // 币安挂了不影响 Telegram；告警不该等到恢复后才发。
    if (this.deps.push && this.deps.notifier) {
      await this.flushOutbox();
    }
  }
}

function transferKey(transfer: TransferRecord): string {
  return `transfer|${transfer.time}|${transfer.coin}|${transfer.amount}|${transfer.transType}`;
}

export interface PositionSummary {
  symbol: string;
  direction: "LONG" | "SHORT";
  netQty: number;
  avgOpenPrice: number;
}

export function renderTransfer(
  label: string,
  transfer: TransferRecord,
  positions: PositionSummary[] = [],
): string {
  const withdraw = transfer.transType.includes("WITHDRAW");
  const directionText = withdraw ? "转出" : "转入";
  const from = withdraw ? "带单账户" : "现货账户";
  const to = withdraw ? "现货账户" : "带单账户";
  const amount = formatAmount(transfer.amount);

  const holding = positions.filter((position) => Math.abs(position.netQty) > 1e-6);
  if (holding.length === 0) {
    return `💸 ${label} 资金${directionText} ${amount} ${transfer.coin}\n${from} → ${to}`;
  }

  const positionText = holding
    .slice(0, 3)
    .map(
      (position) =>
        `${position.symbol} ${position.direction === "LONG" ? "多" : "空"} ${formatQty(position.netQty)}（成本 ${formatUsd(position.netQty * position.avgOpenPrice)}）`,
    )
    .join("；");
  const explain = withdraw
    ? "缓冲变薄、相对敞口变大；同样的仓位，你的强平距离比他更近。"
    : "他补保证金能扛，跟随者没有这一步；同样的仓位，你会更早被强平。";

  return [
    `⚠️ ${label} · 持仓中${withdraw ? "提取保证金" : "补保证金"}`,
    `${directionText} ${amount} ${transfer.coin}（${from} → ${to}）`,
    `当前推定持仓：${positionText}`,
    explain,
  ].join("\n");
}

function formatAmount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatQty(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}
