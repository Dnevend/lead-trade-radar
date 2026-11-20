import { describe, expect, it } from "vitest";
import type { BapiClient } from "../src/adapters/binance/bapi.ts";
import { Store } from "../src/adapters/sqlite/store.ts";
import { TelegramError } from "../src/adapters/telegram/client.ts";
import { TraderRunner, describeError } from "../src/app/runner.ts";
import type { Tweet } from "../src/domain/tweet.ts";
import type { ClosedPosition, LeadOrder, TraderDetail } from "../src/domain/types.ts";
import { loadDetail, loadOrders, loadPositions } from "./helpers.ts";

/** 用回放数据冒充币安接口，验证 bootstrap → cycle → 推送的完整链路。 */
function fakeClient(orders: LeadOrder[], positions: ClosedPosition[], detail: TraderDetail) {
  return {
    async fetchDetail() {
      return detail;
    },
    async fetchClosedPositions() {
      return positions;
    },
    async fetchOrders() {
      return orders;
    },
    async fetchTransfers() {
      return [];
    },
  } as unknown as BapiClient;
}

describe("轮询编排", () => {
  it("bootstrap 静默建账本，新订单只推一次，且不重复发送", async () => {
    const store = new Store(":memory:");
    const positions = loadPositions();
    const orders = loadOrders();
    const detail = loadDetail();
    const sent: string[] = [];

    const runner = new TraderRunner(
      {
        store,
        client: fakeClient(orders, positions, detail),
        notifier: {
          async sendMessage(text: string) {
            sent.push(text);
            return { messageId: sent.length };
          },
        },
        push: true,
        bootstrapDays: 14,
        now: () => 1_794_600_000_000,
        log: () => {},
      },
      { id: "aoying", portfolioId: detail.leadPortfolioId, label: detail.nickname, enabled: true },
    );

    await runner.bootstrapIfNeeded();
    const trader = store.getTrader("aoying")!;
    expect(trader.bootstrapDone).toBe(true);
    expect(trader.lastSeenMs).toBe(Math.max(...orders.map((o) => o.orderUpdateTime)));

    // 第一轮：都是 bootstrap 见过的订单，不产生信号
    expect(await runner.cycle()).toHaveLength(0);
    expect(sent).toHaveLength(0);

    // 追加一笔新开仓，下一轮应恰好推一条
    const synthetic: LeadOrder = {
      symbol: "ETHUSDT",
      baseAsset: "ETH",
      quoteAsset: "USDT",
      side: "SELL",
      positionSide: "SHORT",
      type: "MARKET",
      executedQty: 10,
      avgPrice: 2000,
      totalPnl: 0,
      orderTime: trader.lastSeenMs + 1_000,
      orderUpdateTime: trader.lastSeenMs + 1_000,
    };
    const runnerWithNewOrder = new TraderRunner(
      {
        store,
        client: fakeClient([...orders, synthetic], positions, detail),
        notifier: {
          async sendMessage(text: string) {
            sent.push(text);
            return { messageId: sent.length };
          },
        },
        push: true,
        bootstrapDays: 14,
        now: () => 1_794_600_100_000,
        log: () => {},
      },
      { id: "aoying", portfolioId: detail.leadPortfolioId, label: detail.nickname, enabled: true },
    );

    const emitted = await runnerWithNewOrder.cycle();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("开空 ETHUSDT");
    expect(sent).toHaveLength(1);
    expect(store.listPendingSignals()).toHaveLength(0);

    // 再跑一轮：同一批订单不会重复推
    const again = new TraderRunner(
      {
        store,
        client: fakeClient([...orders, synthetic], positions, detail),
        notifier: {
          async sendMessage(text: string) {
            sent.push(text);
            return { messageId: sent.length };
          },
        },
        push: true,
        bootstrapDays: 14,
        now: () => 1_794_600_200_000,
        log: () => {},
      },
      { id: "aoying", portfolioId: detail.leadPortfolioId, label: detail.nickname, enabled: true },
    );
    expect(await again.cycle()).toHaveLength(0);
    expect(sent).toHaveLength(1);
    store.close();
  });

  it("同一委托后续补量只记差额，不重复计账", async () => {
    const store = new Store(":memory:");
    const positions = loadPositions();
    const orders = loadOrders();
    const detail = loadDetail();
    const traderConfig = { id: "aoying", portfolioId: detail.leadPortfolioId, label: detail.nickname, enabled: true };
    const makeRunner = (all: LeadOrder[], now: number) =>
      new TraderRunner(
        {
          store,
          client: fakeClient(all, positions, detail),
          notifier: null,
          push: false,
          bootstrapDays: 14,
          now: () => now,
          log: () => {},
        },
        traderConfig,
      );

    await makeRunner(orders, 1_794_600_000_000).bootstrapIfNeeded();

    const base = [...orders]
      .filter((o) => o.symbol === "NVDAUSDT" && o.side === "BUY")
      .sort((a, b) => a.orderUpdateTime - b.orderUpdateTime)
      .at(-1)!;
    const grown: LeadOrder = { ...base, executedQty: 2_000 };
    const replaced = orders.map((o) => (o === base ? grown : o));

    const emitted = await makeRunner(replaced, 1_794_600_100_000).cycle();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("加多 NVDAUSDT");
    expect(emitted[0]).toContain("417.72");
    expect(emitted[0]).not.toContain("2,000");

    const ledger = store.loadLedger("aoying");
    expect(ledger.get("NVDAUSDT|LONG")?.netQty).toBeCloseTo(3206.99 + 417.72, 2);

    // 同一快照再来一轮不会重复
    expect(await makeRunner(replaced, 1_794_600_200_000).cycle()).toHaveLength(0);
    store.close();
  });

  it("同毫秒多笔委托中有一笔补量时，只记差额", async () => {
    const store = new Store(":memory:");
    const positions = loadPositions();
    const orders = loadOrders();
    const detail = loadDetail();
    const traderConfig = { id: "aoying", portfolioId: detail.leadPortfolioId, label: detail.nickname, enabled: true };
    const makeRunner = (all: LeadOrder[], now: number) =>
      new TraderRunner(
        {
          store,
          client: fakeClient(all, positions, detail),
          notifier: null,
          push: false,
          bootstrapDays: 14,
          now: () => now,
          log: () => {},
        },
        traderConfig,
      );

    await makeRunner(orders, 1_794_600_000_000).bootstrapIfNeeded();

    // 11-05 19:14:46 同毫秒有 3 笔 ETH 平仓单，把其中一笔从 1000 补到 1001
    const batch = orders.filter((o) => o.symbol === "ETHUSDT" && o.orderTime === 1_793_906_086_087);
    expect(batch).toHaveLength(3);
    const target = batch.find((o) => Math.abs(o.avgPrice - 2_256.12826) < 1e-6)!;
    const grown: LeadOrder = { ...target, executedQty: 1_001 };
    const replaced = orders.map((o) => (o === target ? grown : o));

    const emitted = await makeRunner(replaced, 1_794_600_100_000).cycle();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("减空 ETHUSDT");
    expect(emitted[0]).toContain("· 1 ETH");
    expect(emitted[0]).not.toContain("1,001");
    store.close();
  });

  it("Telegram 永久错误跳过，不堵住后续信号", async () => {
    const store = new Store(":memory:");
    const positions = loadPositions();
    const orders = loadOrders();
    const detail = loadDetail();
    const traderConfig = { id: "aoying", portfolioId: detail.leadPortfolioId, label: detail.nickname, enabled: true };
    const sent: string[] = [];
    let failNext = true;

    const notifier = {
      async sendMessage(text: string) {
        if (failNext) {
          failNext = false;
          throw new TelegramError("Telegram 400: chat not found", 400);
        }
        sent.push(text);
        return { messageId: sent.length };
      },
    };

    const makeRunner = (all: LeadOrder[], now: number) =>
      new TraderRunner(
        {
          store,
          client: fakeClient(all, positions, detail),
          notifier,
          push: true,
          bootstrapDays: 14,
          now: () => now,
          log: () => {},
        },
        traderConfig,
      );

    await makeRunner(orders, 1_794_600_000_000).bootstrapIfNeeded();
    const lastSeen = store.getTrader("aoying")!.lastSeenMs;

    const first: LeadOrder = {
      symbol: "ETHUSDT",
      baseAsset: "ETH",
      quoteAsset: "USDT",
      side: "SELL",
      positionSide: "SHORT",
      type: "MARKET",
      executedQty: 10,
      avgPrice: 2_000,
      totalPnl: 0,
      orderTime: lastSeen + 1_000,
      orderUpdateTime: lastSeen + 1_000,
    };
    await makeRunner([...orders, first], 1_794_600_100_000).cycle();
    // 第一条被 400 永久拒收，已标记跳过，队列清空
    expect(store.listPendingSignals()).toHaveLength(0);
    expect(sent).toHaveLength(0);

    const second: LeadOrder = { ...first, executedQty: 11, orderTime: lastSeen + 2_000, orderUpdateTime: lastSeen + 2_000 };
    await makeRunner([...orders, first, second], 1_794_600_200_000).cycle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("加空 ETHUSDT");
    expect(store.listPendingSignals()).toHaveLength(0);
    store.close();
  });

  it("拉取失败不推进游标；连续三次失败写一条告警", async () => {
    const store = new Store(":memory:");
    const positions = loadPositions();
    const orders = loadOrders();
    const detail = loadDetail();
    const traderConfig = { id: "aoying", portfolioId: detail.leadPortfolioId, label: detail.nickname, enabled: true };

    const healthy = new TraderRunner(
      {
        store,
        client: fakeClient(orders, positions, detail),
        notifier: null,
        push: false,
        bootstrapDays: 14,
        now: () => 1_794_600_000_000,
        log: () => {},
      },
      traderConfig,
    );
    await healthy.bootstrapIfNeeded();
    await healthy.cycle();
    const before = store.getTrader("aoying")!.lastSeenMs;

    const broken = new TraderRunner(
      {
        store,
        client: {
          async fetchDetail() {
            return detail;
          },
          async fetchClosedPositions() {
            return positions;
          },
          async fetchOrders(): Promise<LeadOrder[]> {
            throw new Error("ECONNRESET");
          },
          async fetchTransfers() {
            return [];
          },
        } as unknown as BapiClient,
        notifier: null,
        push: false,
        bootstrapDays: 14,
        now: () => 1_794_600_100_000,
        log: () => {},
      },
      traderConfig,
    );

    await expect(broken.cycle()).rejects.toThrow("ECONNRESET");
    expect(store.getTrader("aoying")!.lastSeenMs).toBe(before);

    await broken.reportFailure(new Error("ECONNRESET"));
    await broken.reportFailure(new Error("ECONNRESET"));
    expect(store.getHealth("aoying").failures).toBe(2);
    await broken.reportFailure(new Error("ECONNRESET"));
    const alerts = store.listSignals(10).filter((row) => row.action === "alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain("连续 3 次");

    // 恢复后补一条恢复通知，且只发一次。
    const recovered = new TraderRunner(
      {
        store,
        client: fakeClient(orders, positions, detail),
        notifier: null,
        push: false,
        bootstrapDays: 14,
        now: () => 1_794_600_180_000,
        log: () => {},
      },
      traderConfig,
    );
    await recovered.cycle();
    const recoveryAlerts = store
      .listSignals(20)
      .filter((row) => row.action === "alert" && row.text.includes("已恢复"));
    expect(recoveryAlerts).toHaveLength(1);
    expect(recoveryAlerts[0]!.text).toContain("中断约 3 分钟");
    expect(recoveryAlerts[0]!.text).toContain("ECONNRESET");
    await recovered.cycle();
    expect(
      store.listSignals(20).filter((row) => row.action === "alert" && row.text.includes("已恢复")),
    ).toHaveLength(1);
    store.close();
  });

  it("告警展开 fetch failed 的底层 cause", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7890"), { code: "ECONNREFUSED" });
    const error = Object.assign(new TypeError("fetch failed"), { cause });
    const text = describeError(error);
    expect(text).toContain("fetch failed");
    expect(text).toContain("ECONNREFUSED");
    expect(text).toContain("127.0.0.1:7890");
  });

  it("skipBacklogOnStart：停机期间的订单静默入库，重开不补推", async () => {
    const store = new Store(":memory:");
    const positions = loadPositions();
    const detail = loadDetail();
    const traderConfig = { id: "aoying", portfolioId: detail.leadPortfolioId, label: detail.nickname, enabled: true };

    const lastSeen = 1_794_600_000_000;
    store.upsertTrader({
      id: "aoying",
      portfolioId: detail.leadPortfolioId,
      label: detail.nickname,
      lastSeenMs: lastSeen,
      bootstrapDone: true,
      disabledReason: null,
    });

    // 停机期间（最后游标之后）成交两笔
    const missed: LeadOrder[] = [
      newLeadOrder(lastSeen, 3_600_000),
      { ...newLeadOrder(lastSeen, 7_200_000), executedQty: 11 },
    ];
    // 一笔“分页没拉到”的积压：静默追平没覆盖到，但也不能在正式轮询里被补推。
    const straggler = newLeadOrder(lastSeen, 10_800_000);
    let includeStraggler = false;
    const client = {
      async fetchDetail() {
        return detail;
      },
      async fetchClosedPositions() {
        return positions;
      },
      async fetchOrders(_portfolioId: string, startTime: number, endTime: number) {
        const all = includeStraggler ? [...missed, straggler] : missed;
        return all.filter((o) => o.orderUpdateTime >= startTime && o.orderUpdateTime <= endTime);
      },
      async fetchTransfers() {
        return [];
      },
    } as unknown as BapiClient;

    const sent: string[] = [];
    const notifier = {
      async sendMessage(text: string) {
        sent.push(text);
        return { messageId: sent.length };
      },
    };

    // 启动时的 shadow 追平轮：信号照常渲染入库，但一条都不发
    const silent = new TraderRunner(
      {
        store,
        client,
        notifier,
        push: false,
        bootstrapDays: 14,
        now: () => lastSeen + 86_400_000,
        log: () => {},
      },
      traderConfig,
    );
    const emitted = await silent.cycle();
    expect(emitted).toHaveLength(2);
    expect(sent).toHaveLength(0);
    expect(store.listPendingSignals()).toHaveLength(0);
    expect(store.listSignals(10).every((row) => row.sentAt !== null)).toBe(true);
    expect(store.getTrader("aoying")!.lastSeenMs).toBe(lastSeen + 7_200_000);

    // 兜底：追平后把游标对齐当前，分页没拉到的积压也不会在正式轮询里补推
    includeStraggler = true;
    silent.alignCursorToNow();
    expect(store.getTrader("aoying")!.lastSeenMs).toBe(lastSeen + 86_400_000);

    // 随后常驻 runner 正常轮询：停机期间的订单已入库，不会补推
    const live = new TraderRunner(
      {
        store,
        client,
        notifier,
        push: true,
        bootstrapDays: 14,
        now: () => lastSeen + 86_400_060_000,
        log: () => {},
      },
      traderConfig,
    );
    expect(await live.cycle()).toHaveLength(0);
    expect(sent).toHaveLength(0);
    store.close();
  });
});

function xTweet(id: string, text = `tweet ${id}`): Tweet {
  return {
    id,
    text,
    createdAt: 1_794_600_000_000,
    url: `https://x.com/thankUcrypto/status/${id}`,
    authorHandle: "thankUcrypto",
    replyTo: null,
    repostedBy: null,
    media: [],
  };
}

function newLeadOrder(lastSeen: number, offset = 1_000): LeadOrder {
  return {
    symbol: "ETHUSDT",
    baseAsset: "ETH",
    quoteAsset: "USDT",
    side: "SELL",
    positionSide: "SHORT",
    type: "MARKET",
    executedQty: 10,
    avgPrice: 2_000,
    totalPnl: 0,
    orderTime: lastSeen + offset,
    orderUpdateTime: lastSeen + offset,
  };
}

describe("信号后补推 X 推文", () => {
  it("信号先发、推文后发，按游标去重且只发原创/自引", async () => {
    const store = new Store(":memory:");
    const positions = loadPositions();
    const orders = loadOrders();
    const detail = loadDetail();
    const sent: string[] = [];
    const xCalls: string[] = [];
    let clock = 1_794_600_000_000;
    let currentOrders = orders;
    let feed: Tweet[] = [xTweet("2121593758101942700")];

    const client = {
      async fetchDetail() {
        return detail;
      },
      async fetchClosedPositions() {
        return positions;
      },
      async fetchOrders() {
        return currentOrders;
      },
      async fetchTransfers() {
        return [];
      },
    } as unknown as BapiClient;

    const runner = new TraderRunner(
      {
        store,
        client,
        notifier: {
          async sendMessage(text: string) {
            sent.push(text);
            return { messageId: sent.length };
          },
        },
        push: true,
        bootstrapDays: 14,
        now: () => clock,
        log: () => {},
        tweetSource: {
          async fetchRecentTweets(handle: string) {
            xCalls.push(handle);
            return feed;
          },
        },
      },
      { id: "aoying", portfolioId: detail.leadPortfolioId, label: detail.nickname, enabled: true, xHandle: "thankUcrypto" },
    );

    await runner.bootstrapIfNeeded();
    clock += 10_000;
    expect(await runner.cycle()).toHaveLength(0);
    // 第一次运行只建立基线，不补发历史
    expect(xCalls).toEqual(["thankUcrypto"]);
    expect(store.getTweetState("aoying")).toEqual({ lastTweetId: "2121593758101942700", pendingSince: null });
    expect(sent).toHaveLength(0);

    // 新订单 + 两条新推文 + 别人的回复/转推：推文应过滤后按时间升序合并且在信号之后
    const lastSeen = store.getTrader("aoying")!.lastSeenMs;
    currentOrders = [...orders, newLeadOrder(lastSeen)];
    feed = [
      xTweet("2121593758101942703", "别人的回复"),
      xTweet("2121593758101942702", "第二条"),
      xTweet("2121593758101942701", "第一条"),
      xTweet("2121593758101942700"),
    ];
    feed[0] = { ...feed[0]!, authorHandle: "someone", replyTo: "thankUcrypto" };
    feed.push({ ...xTweet("2121593758101942704", "转推"), authorHandle: "heyibinance", repostedBy: "thankUcrypto" });

    clock += 100_000;
    const emitted = await runner.cycle();
    expect(emitted).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("开空 ETHUSDT");
    expect(sent[1]).toContain("新推文 2 条");
    expect(sent[1]!.indexOf("第一条")).toBeLessThan(sent[1]!.indexOf("第二条"));
    expect(sent[1]).not.toContain("别人的回复");
    expect(sent[1]).not.toContain("转推");
    expect(store.getTweetState("aoying")).toEqual({ lastTweetId: "2121593758101942704", pendingSince: null });

    // 没有新订单、没有新推文：不重复发送
    clock += 100_000;
    expect(await runner.cycle()).toHaveLength(0);
    expect(sent).toHaveLength(2);
    store.close();
  });

  it("推文拉取失败不影响信号，冷却后重试", async () => {
    const store = new Store(":memory:");
    const positions = loadPositions();
    const orders = loadOrders();
    const detail = loadDetail();
    const sent: string[] = [];
    let clock = 1_794_600_000_000;
    let currentOrders = orders;
    let feed: Tweet[] = [xTweet("2121593758101942800")];
    let fail = false;
    let xCalls = 0;

    const client = {
      async fetchDetail() {
        return detail;
      },
      async fetchClosedPositions() {
        return positions;
      },
      async fetchOrders() {
        return currentOrders;
      },
      async fetchTransfers() {
        return [];
      },
    } as unknown as BapiClient;

    const runner = new TraderRunner(
      {
        store,
        client,
        notifier: {
          async sendMessage(text: string) {
            sent.push(text);
            return { messageId: sent.length };
          },
        },
        push: true,
        bootstrapDays: 14,
        now: () => clock,
        log: () => {},
        tweetSource: {
          async fetchRecentTweets() {
            xCalls += 1;
            if (fail) {
              throw new Error("fx down");
            }
            return feed;
          },
        },
      },
      { id: "aoying", portfolioId: detail.leadPortfolioId, label: detail.nickname, enabled: true, xHandle: "thankUcrypto" },
    );

    await runner.bootstrapIfNeeded();
    clock += 10_000;
    await runner.cycle();
    expect(store.getTweetState("aoying").lastTweetId).toBe("2121593758101942800");

    // 新信号 + 推文接口故障：信号照常送达，推文标记待补
    const lastSeen = store.getTrader("aoying")!.lastSeenMs;
    currentOrders = [...orders, newLeadOrder(lastSeen)];
    fail = true;
    feed = [xTweet("2121593758101942801"), xTweet("2121593758101942800")];
    clock += 100_000;
    await runner.cycle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("开空 ETHUSDT");
    expect(store.getTweetState("aoying").pendingSince).not.toBeNull();

    // 冷却期内不重复打接口
    const callsAfterFailure = xCalls;
    clock += 60_000;
    await runner.cycle();
    expect(xCalls).toBe(callsAfterFailure);

    // 冷却结束后补推
    fail = false;
    clock += 6 * 60_000;
    await runner.cycle();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("新推文 1 条");
    expect(store.getTweetState("aoying")).toEqual({ lastTweetId: "2121593758101942801", pendingSince: null });
    expect(store.listPendingSignals()).toHaveLength(0);
    store.close();
  });
});
