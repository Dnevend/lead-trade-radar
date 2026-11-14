/**
 * 币安带单页站内接口适配器（docs/spec.md §2）。
 *
 * 这些接口没有官方文档、没有 SLA，路径会轮换（实测 `public` 命名空间下的
 * order-history 已失效，`friendly` 可用）。所以：
 * - 端点用候选列表，遇到 404/5xx 换下一个；
 * - 响应必须过 zod 校验，字段变了就报 SchemaChangedError，绝不把缺字段当 0；
 * - 只有 HTTP 层可重试，业务错误码（11012005 系统忙）按退避重试，其余直接抛。
 */

import retry from "p-retry";
import { z } from "zod";
import { orderDedupeKey } from "../../domain/order.ts";
import type { ClosedPosition, LeadOrder, TraderDetail, TransferRecord } from "../../domain/types.ts";

const BASE_URL = "https://www.binance.com";

const ENDPOINTS = {
  orderHistory: [
    "/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history",
    "/bapi/futures/v1/public/future/copy-trade/lead-portfolio/order-history",
  ],
  positionHistory: [
    "/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/position-history",
    "/bapi/futures/v1/public/future/copy-trade/lead-portfolio/position-history",
  ],
  transferHistory: [
    "/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/transfer-history",
    "/bapi/futures/v1/public/future/copy-trade/lead-portfolio/transfer-history",
  ],
  detail: [
    "/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail",
    "/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail",
  ],
} as const;

export type EndpointName = keyof typeof ENDPOINTS;

export class BapiError extends Error {
  readonly endpoint: EndpointName;
  readonly status: number;
  readonly code: string | null;

  constructor(endpoint: EndpointName, message: string, status: number, code: string | null) {
    super(message);
    this.name = "BapiError";
    this.endpoint = endpoint;
    this.status = status;
    this.code = code;
  }
}

export class SchemaChangedError extends Error {
  constructor(endpoint: EndpointName, detail: string) {
    super(`${endpoint} 响应结构变了：${detail}`);
    this.name = "SchemaChangedError";
  }
}

const envelope = z.object({
  code: z.string().optional(),
  success: z.boolean().optional(),
  message: z.string().nullish(),
  data: z.unknown(),
});

const orderSchema = z.object({
  symbol: z.string(),
  baseAsset: z.string().optional().default(""),
  quoteAsset: z.string().optional().default("USDT"),
  side: z.enum(["BUY", "SELL"]),
  positionSide: z.enum(["LONG", "SHORT", "BOTH"]).optional().default("BOTH"),
  type: z.string().optional().default(""),
  executedQty: z.coerce.number(),
  avgPrice: z.coerce.number(),
  totalPnl: z.coerce.number().optional().default(0),
  orderTime: z.coerce.number(),
  orderUpdateTime: z.coerce.number().optional(),
});

const orderListSchema = z.object({
  total: z.coerce.number().optional().default(0),
  list: z.array(orderSchema),
});

const closedSchema = z.object({
  id: z.coerce.string().optional(),
  positionId: z.coerce.string(),
  symbol: z.string(),
  opened: z.coerce.number(),
  closed: z.coerce.number(),
  avgCost: z.coerce.number(),
  avgClosePrice: z.coerce.number(),
  closingPnl: z.coerce.number(),
  closedVolume: z.coerce.number().optional().default(0),
  leverage: z.coerce.number().optional().default(0),
  roi: z.coerce.number().optional().default(0),
  side: z.enum(["Long", "Short"]),
  status: z.string().optional().default(""),
});

const closedListSchema = z.object({
  total: z.coerce.number().optional().default(0),
  list: z.array(closedSchema),
});

const transferSchema = z.object({
  time: z.coerce.number(),
  coin: z.string(),
  amount: z.coerce.number(),
  from: z.string(),
  to: z.string(),
  transType: z.string().optional().default(""),
});

const transferListSchema = z.object({
  total: z.coerce.number().optional().default(0),
  list: z.array(transferSchema),
});

const detailSchema = z.object({
  leadPortfolioId: z.string(),
  nickname: z.string(),
  status: z.string().optional().default(""),
  positionShow: z.boolean().optional().default(false),
  marginBalance: z.coerce.number().optional().default(0),
  aumAmount: z.coerce.number().optional().default(0),
  lastTradeTime: z.coerce.number().optional().default(0),
});

export interface BapiClientOptions {
  fetch: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  /** 测试/回放时替换 sleep。 */
  sleep?: (ms: number) => Promise<void>;
}

export class BapiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(options: BapiClientOptions) {
    this.fetchImpl = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retries = options.retries ?? 3;
  }

  async fetchDetail(portfolioId: string): Promise<TraderDetail> {
    const data = await this.get("detail", `?portfolioId=${encodeURIComponent(portfolioId)}`, portfolioId);
    const parsed = detailSchema.safeParse(data);
    if (!parsed.success) {
      throw new SchemaChangedError("detail", parsed.error.issues.map((i) => i.path.join(".")).join(","));
    }
    return parsed.data;
  }

  async fetchOrders(portfolioId: string, startTime: number, endTime: number): Promise<LeadOrder[]> {
    return this.fetchOrdersPaged("orderHistory", portfolioId, startTime, endTime);
  }

  async fetchClosedPositions(portfolioId: string, pages = 2, pageSize = 100): Promise<ClosedPosition[]> {
    const out: ClosedPosition[] = [];
    const seen = new Set<string>();
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const data = await this.post("positionHistory", { portfolioId, pageNumber, pageSize });
      const parsed = closedListSchema.safeParse(data);
      if (!parsed.success) {
        throw new SchemaChangedError("positionHistory", parsed.error.issues.map((i) => i.path.join(".")).join(","));
      }
      for (const record of parsed.data.list) {
        if (!seen.has(record.positionId)) {
          seen.add(record.positionId);
          out.push({
            positionId: record.positionId,
            symbol: record.symbol,
            side: record.side,
            opened: record.opened,
            closed: record.closed,
            avgCost: record.avgCost,
            avgClosePrice: record.avgClosePrice,
            closingPnl: record.closingPnl,
            closedVolume: record.closedVolume,
            leverage: record.leverage,
            roi: record.roi,
            status: record.status,
          });
        }
      }
      if (parsed.data.list.length < pageSize) {
        break;
      }
    }
    return out;
  }

  async fetchTransfers(portfolioId: string, pageSize = 50): Promise<TransferRecord[]> {
    const data = await this.post("transferHistory", { portfolioId, pageNumber: 1, pageSize });
    const parsed = transferListSchema.safeParse(data);
    if (!parsed.success) {
      throw new SchemaChangedError("transferHistory", parsed.error.issues.map((i) => i.path.join(".")).join(","));
    }
    return parsed.data.list;
  }

  private async fetchOrdersPaged(
    endpoint: EndpointName,
    portfolioId: string,
    startTime: number,
    endTime: number,
  ): Promise<LeadOrder[]> {
    const pageSize = 100;
    const maxPages = 10;
    const out: LeadOrder[] = [];
    const seen = new Set<string>();
    let total = Number.POSITIVE_INFINITY;

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const data = await this.post(endpoint, { portfolioId, startTime, endTime, pageSize, pageNumber });
      const parsed = orderListSchema.safeParse(data);
      if (!parsed.success) {
        throw new SchemaChangedError(endpoint, parsed.error.issues.map((i) => i.path.join(".")).join(","));
      }
      total = parsed.data.total;
      let added = 0;
      for (const raw of parsed.data.list) {
        const order: LeadOrder = {
          symbol: raw.symbol,
          baseAsset: raw.baseAsset || raw.symbol.replace(/USDT$/i, ""),
          quoteAsset: raw.quoteAsset,
          side: raw.side,
          positionSide: raw.positionSide,
          type: raw.type,
          executedQty: raw.executedQty,
          avgPrice: raw.avgPrice,
          totalPnl: raw.totalPnl,
          orderTime: raw.orderTime,
          orderUpdateTime: raw.orderUpdateTime ?? raw.orderTime,
        };
        // 同一毫秒可能有多笔独立委托，必须用完整指纹（含数量与均价）去重，
        // 不能用 symbol|side|positionSide|orderTime —— 实测会吃掉真实订单。
        const key = orderDedupeKey(order);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(order);
          added += 1;
        }
      }
      // 整页都是已见过的（跨页重叠），或者已经拿够，停止翻页。
      if (parsed.data.list.length === 0 || added === 0 || out.length >= total) {
        break;
      }
    }
    return out;
  }

  private async get(endpoint: EndpointName, query: string, portfolioId = ""): Promise<unknown> {
    const errors: string[] = [];
    for (const path of ENDPOINTS[endpoint]) {
      try {
        return await this.request(`${path}${query}`, { method: "GET" }, endpoint, portfolioId);
      } catch (error) {
        errors.push(describe(error));
        if (!isEndpointMiss(error)) {
          throw error;
        }
      }
    }
    throw new BapiError(endpoint, `${endpoint} 全部端点不可用：${errors.join("；")}`, 0, null);
  }

  private async post(
    endpoint: EndpointName,
    body: Record<string, unknown>,
    portfolioId = String(body.portfolioId ?? ""),
  ): Promise<unknown> {
    const errors: string[] = [];
    for (const path of ENDPOINTS[endpoint]) {
      try {
        return await this.request(
          path,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
          endpoint,
          portfolioId,
        );
      } catch (error) {
        errors.push(describe(error));
        if (!isEndpointMiss(error)) {
          throw error;
        }
      }
    }
    throw new BapiError(endpoint, `${endpoint} 全部端点不可用：${errors.join("；")}`, 0, null);
  }

  private async request(
    path: string,
    init: RequestInit,
    endpoint: EndpointName,
    portfolioId: string,
  ): Promise<unknown> {
    return retry(
      async () => {
        const response = await this.fetchImpl(`${BASE_URL}${path}`, {
          ...init,
          headers: {
            accept: "*/*",
            clienttype: "web",
            lang: "zh-CN",
            origin: BASE_URL,
            referer: portfolioId
              ? `${BASE_URL}/zh-CN/copy-trading/lead-details/${portfolioId}`
              : `${BASE_URL}/zh-CN/copy-trading`,
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            ...(init.headers as Record<string, string> | undefined),
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        const text = await response.text();
        if (response.status === 404 || response.status === 202) {
          throw new BapiError(endpoint, `HTTP ${response.status}`, response.status, null);
        }
        if (response.status === 429 || response.status >= 500) {
          throw new BapiError(endpoint, `HTTP ${response.status}`, response.status, null);
        }
        if (!response.ok) {
          throw new BapiError(endpoint, `HTTP ${response.status}: ${text.slice(0, 120)}`, response.status, null);
        }

        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new BapiError(endpoint, `响应不是 JSON：${text.slice(0, 120)}`, response.status, null);
        }

        const env = envelope.safeParse(json);
        if (!env.success) {
          throw new SchemaChangedError(endpoint, "响应缺少 code/success/data");
        }
        if (env.data.success !== true || env.data.code !== "000000") {
          // 11012005 系统忙；其余业务错误不重试
          if (env.data.code === "11012005") {
            throw new BapiError(endpoint, `业务错误 ${env.data.code}`, response.status, env.data.code);
          }
          throw new BapiError(
            endpoint,
            `业务错误 ${env.data.code ?? "?"}: ${env.data.message ?? ""}`,
            response.status,
            env.data.code ?? null,
          );
        }
        return env.data.data;
      },
      {
        retries: this.retries,
        minTimeout: 800,
        maxTimeout: 8_000,
        factor: 2,
        // 只有网络故障、429、“系统忙”才重试；业务错误和结构变化立刻失败。
        shouldRetry: ({ error }) => {
          if (error instanceof SchemaChangedError) {
            return false;
          }
          if (error instanceof BapiError) {
            return error.code === "11012005" || error.status === 429 || error.status >= 500;
          }
          return true;
        },
      },
    );
  }
}

function isEndpointMiss(error: unknown): boolean {
  return error instanceof BapiError && (error.status === 404 || error.status === 202);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
