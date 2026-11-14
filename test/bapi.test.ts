import { describe, expect, it } from "vitest";
import { BapiClient, BapiError, SchemaChangedError } from "../src/adapters/binance/bapi.ts";
import { loadOrders } from "./helpers.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("币安接口适配器", () => {
  it("friendly 端点 404 时自动换到下一个候选", async () => {
    const calls: string[] = [];
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/friendly/")) {
        return new Response("not found", { status: 404 });
      }
      return jsonResponse({
        code: "000000",
        success: true,
        data: {
          total: 1,
          list: [
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
          ],
        },
      });
    }) as unknown as typeof fetch;

    const client = new BapiClient({ fetch: fetchMock, retries: 0 });
    const orders = await client.fetchOrders("123", 0, 10);
    expect(orders).toHaveLength(1);
    expect(calls.some((url) => url.includes("/friendly/"))).toBe(true);
    expect(calls.some((url) => url.includes("/public/"))).toBe(true);
  });

  it("字段缺失时抛 SchemaChangedError，不把空值当 0", async () => {
    const fetchMock = (async () =>
      jsonResponse({ code: "000000", success: true, data: { total: 1, list: [{ symbol: "BTCUSDT" }] } })) as unknown as typeof fetch;
    const client = new BapiClient({ fetch: fetchMock, retries: 0 });
    await expect(client.fetchOrders("123", 0, 10)).rejects.toBeInstanceOf(SchemaChangedError);
  });

  it("业务错误直接抛出，不重试", async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      return jsonResponse({ code: "11012030", success: false, message: "项目已关闭", data: null });
    }) as unknown as typeof fetch;
    const client = new BapiClient({ fetch: fetchMock, retries: 3 });
    await expect(client.fetchOrders("123", 0, 10)).rejects.toBeInstanceOf(BapiError);
    expect(calls).toBe(1);
  });

  it("同一毫秒的多笔独立委托不会被预去重吃掉", async () => {
    const orders = loadOrders();
    const fetchMock = (async () =>
      jsonResponse({ code: "000000", success: true, data: { total: orders.length, list: orders } })) as unknown as typeof fetch;
    const client = new BapiClient({ fetch: fetchMock, retries: 0 });
    const fetched = await client.fetchOrders("123", 0, 1);
    expect(fetched).toHaveLength(60);
    const eth = fetched.filter((o) => o.symbol === "ETHUSDT" && o.orderTime === 1793906086087);
    expect(eth).toHaveLength(3);
  });

  it("detail 的字符串数值会被转成 number", async () => {
    const fetchMock = (async () =>
      jsonResponse({
        code: "000000",
        success: true,
        data: {
          leadPortfolioId: "123",
          nickname: "熬鹰资本",
          positionShow: false,
          marginBalance: "329274.65727573",
          status: "ACTIVE",
        },
      })) as unknown as typeof fetch;
    const client = new BapiClient({ fetch: fetchMock, retries: 0 });
    const detail = await client.fetchDetail("123");
    expect(detail.marginBalance).toBeCloseTo(329274.65727573, 6);
    expect(detail.positionShow).toBe(false);
  });
});
