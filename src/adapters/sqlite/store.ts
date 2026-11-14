/**
 * SQLite 持久化（docs/spec.md §8）。只存「已经处理过的事实」，重启不重发。
 *
 * 用 Node 内置 `node:sqlite`，不引原生依赖；`:memory:` 供测试使用。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Ledger, LedgerState } from "../../domain/ledger.ts";
import type { LeadOrder } from "../../domain/types.ts";
import type { ClosedPosition } from "../../domain/types.ts";

export interface TraderRow {
  id: string;
  portfolioId: string;
  label: string;
  lastSeenMs: number;
  bootstrapDone: boolean;
  /** 非空表示该项目已停止监控（如带单项目关闭），重启后不再排程。 */
  disabledReason: string | null;
}

export interface SignalRow {
  traderId: string;
  dedupeKey: string;
  action: string;
  text: string;
  createdAt: number;
  sentAt: number | null;
  messageId: number | null;
}

export interface HealthRow {
  traderId: string;
  failures: number;
  lastOkAt: number | null;
  lastError: string | null;
}

/** X 推文游标：last_tweet_id 为空表示还没建立基线；pending_since 非空表示有信号已发、等待补推文。 */
export interface TweetState {
  lastTweetId: string | null;
  pendingSince: number | null;
}

/** 一笔委托的当前快照；用于区分「同一委托补量」和「同毫秒的新委托」。 */
export interface OrderSnapshot {
  fingerprint: string;
  executedQty: number;
  avgPrice: number;
  totalPnl: number;
}

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS trader (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT NOT NULL,
    label TEXT NOT NULL,
    last_seen_ms INTEGER NOT NULL DEFAULT 0,
    bootstrap_done INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS lead_order (
    trader_id TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    order_update_time INTEGER NOT NULL,
    payload TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    PRIMARY KEY (trader_id, dedupe_key)
  );
  CREATE INDEX IF NOT EXISTS lead_order_time ON lead_order(trader_id, order_update_time);
  CREATE TABLE IF NOT EXISTS closed_position (
    trader_id TEXT NOT NULL,
    position_id TEXT NOT NULL,
    closed INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (trader_id, position_id)
  );
  CREATE TABLE IF NOT EXISTS ledger (
    trader_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    net_qty REAL NOT NULL,
    avg_open_price REAL NOT NULL,
    opened_qty REAL NOT NULL,
    unknown_baseline INTEGER NOT NULL,
    anchor_closed_at INTEGER NOT NULL,
    PRIMARY KEY (trader_id, symbol, direction)
  );
  CREATE TABLE IF NOT EXISTS signal (
    trader_id TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    action TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    message_id INTEGER,
    PRIMARY KEY (trader_id, dedupe_key)
  );
  CREATE TABLE IF NOT EXISTS health (
    trader_id TEXT PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0,
    last_ok_at INTEGER,
    last_error TEXT
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS order_cursor (
    trader_id TEXT NOT NULL,
    base_key TEXT NOT NULL,
    executed_qty REAL NOT NULL,
    avg_price REAL NOT NULL,
    total_pnl REAL NOT NULL,
    ordinals INTEGER NOT NULL,
    PRIMARY KEY (trader_id, base_key)
  );
  `,
  `
  ALTER TABLE ledger ADD COLUMN last_order_at INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE trader ADD COLUMN disabled_reason TEXT;
  CREATE TABLE order_snapshot (
    trader_id TEXT NOT NULL,
    base_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    executed_qty REAL NOT NULL,
    avg_price REAL NOT NULL,
    total_pnl REAL NOT NULL,
    PRIMARY KEY (trader_id, fingerprint)
  );
  CREATE INDEX order_snapshot_base ON order_snapshot(trader_id, base_key);
  DROP TABLE IF EXISTS order_cursor;
  ALTER TABLE ledger ADD COLUMN last_increase_at INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE IF NOT EXISTS tweet_state (
    trader_id TEXT PRIMARY KEY,
    last_tweet_id TEXT,
    pending_since INTEGER,
    updated_at INTEGER NOT NULL
  );
  `,
];

function mapSignal(row: Record<string, unknown>): SignalRow {
  return {
    traderId: String(row.trader_id),
    dedupeKey: String(row.dedupe_key),
    action: String(row.action),
    text: String(row.text),
    createdAt: Number(row.created_at),
    sentAt: row.sent_at === null ? null : Number(row.sent_at),
    messageId: row.message_id === null ? null : Number(row.message_id),
  };
}

export class Store {  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    // 服务运行时执行 `npm run once`（只读预览）也要能等锁，不能立刻 SQLITE_BUSY。
    this.db.exec("PRAGMA busy_timeout = 5000;");
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > MIGRATIONS.length) {
      throw new Error(`数据库版本 ${version} 高于代码支持的 ${MIGRATIONS.length}，拒绝启动`);
    }
    for (let i = version; i < MIGRATIONS.length; i += 1) {
      this.db.exec(MIGRATIONS[i]!);
    }
    this.db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
  }

  close(): void {
    this.db.close();
  }

  /** 把一组写入包成一个事务：要么全落库，要么全回滚。 */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getTrader(id: string): TraderRow | null {
    const row = this.db.prepare("SELECT * FROM trader WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      portfolioId: String(row.portfolio_id),
      label: String(row.label),
      lastSeenMs: Number(row.last_seen_ms),
      bootstrapDone: Number(row.bootstrap_done) === 1,
      disabledReason: row.disabled_reason === null || row.disabled_reason === undefined ? null : String(row.disabled_reason),
    };
  }

  upsertTrader(row: TraderRow): void {
    this.db
      .prepare(
        `INSERT INTO trader (id, portfolio_id, label, last_seen_ms, bootstrap_done, disabled_reason)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           portfolio_id = excluded.portfolio_id,
           label = excluded.label,
           last_seen_ms = excluded.last_seen_ms,
           bootstrap_done = excluded.bootstrap_done,
           disabled_reason = excluded.disabled_reason`,
      )
      .run(
        row.id,
        row.portfolioId,
        row.label,
        row.lastSeenMs,
        row.bootstrapDone ? 1 : 0,
        row.disabledReason,
      );
  }

  setTraderDisabled(id: string, reason: string): void {
    this.db.prepare("UPDATE trader SET disabled_reason = ? WHERE id = ?").run(reason, id);
  }

  hasOrder(traderId: string, dedupeKey: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM lead_order WHERE trader_id = ? AND dedupe_key = ?").get(traderId, dedupeKey),
    );
  }

  insertOrder(traderId: string, dedupeKey: string, order: LeadOrder, detectedAt: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO lead_order (trader_id, dedupe_key, order_update_time, payload, detected_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(traderId, dedupeKey, order.orderUpdateTime, JSON.stringify(order), detectedAt);
  }

  upsertClosedPositions(traderId: string, records: ClosedPosition[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO closed_position (trader_id, position_id, closed, payload)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(trader_id, position_id) DO UPDATE SET closed = excluded.closed, payload = excluded.payload`,
    );
    for (const record of records) {
      stmt.run(traderId, record.positionId, record.closed, JSON.stringify(record));
    }
  }

  /** 最近的平仓记录，按平仓时间倒序。 */
  listClosedPositions(traderId: string, limit = 50): ClosedPosition[] {
    const rows = this.db
      .prepare("SELECT payload FROM closed_position WHERE trader_id = ? ORDER BY closed DESC LIMIT ?")
      .all(traderId, limit) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as ClosedPosition);
  }

  loadLedger(traderId: string): Ledger {
    const rows = this.db.prepare("SELECT * FROM ledger WHERE trader_id = ?").all(traderId) as Array<
      Record<string, unknown>
    >;
    const ledger: Ledger = new Map();
    for (const row of rows) {
      const state: LedgerState = {
        symbol: String(row.symbol),
        direction: row.direction === "SHORT" ? "SHORT" : "LONG",
        netQty: Number(row.net_qty),
        avgOpenPrice: Number(row.avg_open_price),
        openedQty: Number(row.opened_qty),
        unknownBaseline: Number(row.unknown_baseline) === 1,
        anchorClosedAt: Number(row.anchor_closed_at),
        lastOrderAt: Number(row.last_order_at ?? 0),
        lastIncreaseAt: Number(row.last_increase_at ?? 0),
      };
      ledger.set(`${state.symbol}|${state.direction}`, state);
    }
    return ledger;
  }

  saveLedger(traderId: string, ledger: Ledger): void {
    const stmt = this.db.prepare(
      `INSERT INTO ledger (trader_id, symbol, direction, net_qty, avg_open_price, opened_qty, unknown_baseline, anchor_closed_at, last_order_at, last_increase_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(trader_id, symbol, direction) DO UPDATE SET
         net_qty = excluded.net_qty,
         avg_open_price = excluded.avg_open_price,
         opened_qty = excluded.opened_qty,
         unknown_baseline = excluded.unknown_baseline,
         anchor_closed_at = excluded.anchor_closed_at,
         last_order_at = excluded.last_order_at,
         last_increase_at = excluded.last_increase_at`,
    );
    for (const state of ledger.values()) {
      stmt.run(
        traderId,
        state.symbol,
        state.direction,
        state.netQty,
        state.avgOpenPrice,
        state.openedQty,
        state.unknownBaseline ? 1 : 0,
        state.anchorClosedAt,
        state.lastOrderAt,
        state.lastIncreaseAt,
      );
    }
  }

  insertSignal(row: SignalRow): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO signal (trader_id, dedupe_key, action, text, created_at, sent_at, message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.traderId, row.dedupeKey, row.action, row.text, row.createdAt, row.sentAt, row.messageId);
    return Number(result.changes) > 0;
  }

  markSent(traderId: string, dedupeKey: string, sentAt: number, messageId: number | null): void {
    this.db
      .prepare("UPDATE signal SET sent_at = ?, message_id = ? WHERE trader_id = ? AND dedupe_key = ?")
      .run(sentAt, messageId, traderId, dedupeKey);
  }

  /** 永久性发送失败（chat_id 错、被踢、文本超长）：标记为不再重试，避免堵住队列。 */
  markDropped(traderId: string, dedupeKey: string): void {
    this.db
      .prepare("UPDATE signal SET sent_at = -1, message_id = NULL WHERE trader_id = ? AND dedupe_key = ?")
      .run(traderId, dedupeKey);
  }

  listOrderSnapshots(traderId: string, baseKey: string): OrderSnapshot[] {
    const rows = this.db
      .prepare("SELECT * FROM order_snapshot WHERE trader_id = ? AND base_key = ?")
      .all(traderId, baseKey) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      fingerprint: String(row.fingerprint),
      executedQty: Number(row.executed_qty),
      avgPrice: Number(row.avg_price),
      totalPnl: Number(row.total_pnl),
    }));
  }

  putOrderSnapshot(traderId: string, baseKey: string, snapshot: OrderSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO order_snapshot (trader_id, base_key, fingerprint, executed_qty, avg_price, total_pnl)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(trader_id, fingerprint) DO UPDATE SET
           base_key = excluded.base_key,
           executed_qty = excluded.executed_qty,
           avg_price = excluded.avg_price,
           total_pnl = excluded.total_pnl`,
      )
      .run(traderId, baseKey, snapshot.fingerprint, snapshot.executedQty, snapshot.avgPrice, snapshot.totalPnl);
  }

  deleteOrderSnapshot(traderId: string, fingerprint: string): void {
    this.db.prepare("DELETE FROM order_snapshot WHERE trader_id = ? AND fingerprint = ?").run(traderId, fingerprint);
  }

  listSignals(limit = 20): SignalRow[] {
    const rows = this.db
      .prepare("SELECT * FROM signal ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(mapSignal);
  }

  /** 所有待发送信号，按创建时间升序；同一毫秒内按插入顺序，保证多条推文消息顺序稳定。 */
  listPendingSignals(limit = 50): SignalRow[] {
    const rows = this.db
      .prepare("SELECT * FROM signal WHERE sent_at IS NULL ORDER BY created_at ASC, rowid ASC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(mapSignal);
  }

  getTweetState(traderId: string): TweetState {
    const row = this.db.prepare("SELECT * FROM tweet_state WHERE trader_id = ?").get(traderId) as
      | Record<string, unknown>
      | undefined;
    return {
      lastTweetId: row?.last_tweet_id == null ? null : String(row.last_tweet_id),
      pendingSince: row?.pending_since == null ? null : Number(row.pending_since),
    };
  }

  saveTweetState(traderId: string, state: TweetState): void {
    this.db
      .prepare(
        `INSERT INTO tweet_state (trader_id, last_tweet_id, pending_since, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(trader_id) DO UPDATE SET
           last_tweet_id = excluded.last_tweet_id,
           pending_since = excluded.pending_since,
           updated_at = excluded.updated_at`,
      )
      .run(traderId, state.lastTweetId, state.pendingSince, Date.now());
  }

  /** 信号已真正发出：标记下一次 cycle 需要补推文。 */
  markTweetsPending(traderId: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO tweet_state (trader_id, last_tweet_id, pending_since, updated_at)
         VALUES (?, NULL, ?, ?)
         ON CONFLICT(trader_id) DO UPDATE SET
           pending_since = excluded.pending_since,
           updated_at = excluded.updated_at`,
      )
      .run(traderId, at, Date.now());
  }

  getHealth(traderId: string): HealthRow {
    const row = this.db.prepare("SELECT * FROM health WHERE trader_id = ?").get(traderId) as
      | Record<string, unknown>
      | undefined;
    return {
      traderId,
      failures: row ? Number(row.failures) : 0,
      lastOkAt: row && row.last_ok_at !== null ? Number(row.last_ok_at) : null,
      lastError: row && row.last_error !== null ? String(row.last_error) : null,
    };
  }

  setHealth(row: HealthRow): void {
    this.db
      .prepare(
        `INSERT INTO health (trader_id, failures, last_ok_at, last_error)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(trader_id) DO UPDATE SET
           failures = excluded.failures,
           last_ok_at = excluded.last_ok_at,
           last_error = excluded.last_error`,
      )
      .run(row.traderId, row.failures, row.lastOkAt, row.lastError);
  }
}
