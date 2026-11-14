import { describe, expect, it } from "vitest";
import { Store } from "../src/adapters/sqlite/store.ts";

describe("SQLite 存储", () => {
  it("交易员、订单、信号、账本都能往返", () => {
    const store = new Store(":memory:");
    store.upsertTrader({ id: "t1", portfolioId: "123", label: "测试", lastSeenMs: 0, bootstrapDone: false, disabledReason: null });
    expect(store.getTrader("t1")).toMatchObject({ portfolioId: "123", bootstrapDone: false });

    store.insertOrder(
      "t1",
      "key1",
      {
        symbol: "BTCUSDT",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        side: "BUY",
        positionSide: "LONG",
        type: "MARKET",
        executedQty: 1,
        avgPrice: 100,
        totalPnl: 0,
        orderTime: 1,
        orderUpdateTime: 2,
      },
      3,
    );
    expect(store.hasOrder("t1", "key1")).toBe(true);
    expect(store.hasOrder("t1", "key2")).toBe(false);

    expect(
      store.insertSignal({
        traderId: "t1",
        dedupeKey: "s1",
        action: "open",
        text: "hi",
        createdAt: 10,
        sentAt: null,
        messageId: null,
      }),
    ).toBe(true);
    // 同一条信号重复入库会被忽略
    expect(
      store.insertSignal({
        traderId: "t1",
        dedupeKey: "s1",
        action: "open",
        text: "hi",
        createdAt: 10,
        sentAt: null,
        messageId: null,
      }),
    ).toBe(false);
    expect(store.listPendingSignals()).toHaveLength(1);
    store.markSent("t1", "s1", 20, 99);
    expect(store.listPendingSignals()).toHaveLength(0);
    store.close();
  });

  it("推文游标和待补标记可往返", () => {
    const store = new Store(":memory:");
    expect(store.getTweetState("t1")).toEqual({ lastTweetId: null, pendingSince: null });

    store.saveTweetState("t1", { lastTweetId: "2121593758101942747", pendingSince: null });
    expect(store.getTweetState("t1")).toEqual({ lastTweetId: "2121593758101942747", pendingSince: null });

    store.markTweetsPending("t1", 123);
    expect(store.getTweetState("t1")).toEqual({ lastTweetId: "2121593758101942747", pendingSince: 123 });

    // 标记待补不能清掉已有游标
    expect(store.getTweetState("t1").lastTweetId).toBe("2121593758101942747");

    store.saveTweetState("t1", { lastTweetId: "2121593758101942748", pendingSince: null });
    expect(store.getTweetState("t1")).toEqual({ lastTweetId: "2121593758101942748", pendingSince: null });
    store.close();
  });

  it("账本落盘后可恢复", () => {
    const store = new Store(":memory:");
    const ledger = new Map([
      [
        "BTCUSDT|LONG",
        {
          symbol: "BTCUSDT",
          direction: "LONG" as const,
          netQty: 2,
          avgOpenPrice: 100,
          openedQty: 2,
          unknownBaseline: false,
          anchorClosedAt: 5,
          lastOrderAt: 5,
          lastIncreaseAt: 5,
        },
      ],
    ]);
    store.saveLedger("t1", ledger);
    const restored = store.loadLedger("t1");
    expect(restored.get("BTCUSDT|LONG")).toMatchObject({ netQty: 2, avgOpenPrice: 100 });
    store.close();
  });
});
