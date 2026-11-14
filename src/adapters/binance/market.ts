/**
 * 行情适配器：现价 + 盘口深度。只用于「摊平 / 流动性」提示，失败不影响信号。
 *
 * 用 fapi 公共行情（无需鉴权），5 秒内存缓存；TradFi 合约同样适用。
 */

import type { DepthSnapshot } from "../../domain/followability.ts";

export type PriceFetcher = (symbol: string) => Promise<number | null>;
export type DepthFetcher = (symbol: string) => Promise<DepthSnapshot | null>;

const BASE_URL = "https://fapi.binance.com";

export function createMarkPriceFetcher(fetchImpl: typeof fetch, ttlMs = 5_000): PriceFetcher {
  const cache = new Map<string, { price: number; at: number }>();

  return async (symbol: string): Promise<number | null> => {
    const cached = cache.get(symbol);
    const now = Date.now();
    if (cached && now - cached.at < ttlMs) {
      return cached.price;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchImpl(`${BASE_URL}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
          return null;
        }
        const body = (await response.json()) as { price?: string };
        const price = Number(body.price);
        if (!Number.isFinite(price) || price <= 0) {
          return null;
        }
        cache.set(symbol, { price, at: now });
        return price;
      } catch {
        // 代理偶发抖动重试一次；仍失败就放弃，信号不依赖现价。
        if (attempt === 1) {
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    return null;
  };
}

export function createDepthFetcher(fetchImpl: typeof fetch, ttlMs = 5_000): DepthFetcher {
  const cache = new Map<string, { depth: DepthSnapshot; at: number }>();

  return async (symbol: string): Promise<DepthSnapshot | null> => {
    const cached = cache.get(symbol);
    const now = Date.now();
    if (cached && now - cached.at < ttlMs) {
      return cached.depth;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchImpl(
          `${BASE_URL}/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=100`,
          { signal: AbortSignal.timeout(5_000) },
        );
        if (!response.ok) {
          return null;
        }
        const body = (await response.json()) as { bids?: unknown; asks?: unknown };
        const bids = parseLevels(body.bids);
        const asks = parseLevels(body.asks);
        if (bids.length === 0 || asks.length === 0) {
          return null;
        }
        const depth: DepthSnapshot = { bids, asks };
        cache.set(symbol, { depth, at: now });
        return depth;
      } catch {
        if (attempt === 1) {
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    return null;
  };
}

function parseLevels(raw: unknown): Array<[number, number]> {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Array<[number, number]> = [];
  for (const level of raw) {
    if (!Array.isArray(level) || level.length < 2) {
      continue;
    }
    const price = Number(level[0]);
    const qty = Number(level[1]);
    if (Number.isFinite(price) && Number.isFinite(qty) && price > 0 && qty > 0) {
      out.push([price, qty]);
    }
  }
  return out;
}
