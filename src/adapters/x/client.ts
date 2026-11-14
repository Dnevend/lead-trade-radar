/**
 * X 推文适配器（docs/spec.md §2）。
 *
 * X 官方接口需要登录态且查询 ID 经常轮换，这里用公开镜像 fxtwitter：
 * `GET https://api.fxtwitter.com/2/profile/<handle>/statuses`，无需鉴权。
 * 它是第三方服务，没有 SLA；失败由调用方记日志、保留待补标记并冷却后重试。
 */

import retry from "p-retry";
import { z } from "zod";
import type { Tweet } from "../../domain/tweet.ts";

const BASE_URL = "https://api.fxtwitter.com";

export class XApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "XApiError";
    this.status = status;
  }
}

const authorSchema = z.object({
  screen_name: z.string(),
});

const statusSchema = z.object({
  type: z.string().optional().default("status"),
  id: z.union([z.string(), z.number()]).transform((value) => String(value)),
  text: z.string(),
  created_timestamp: z.number(),
  url: z.string().optional(),
  author: authorSchema,
  replying_to: z.object({ screen_name: z.string() }).nullish(),
  reposted_by: z.object({ screen_name: z.string() }).nullish(),
  media: z
    .object({
      all: z.array(z.object({ type: z.string() })).optional(),
    })
    .optional(),
});

const envelopeSchema = z.object({
  code: z.coerce.number(),
  message: z.string().optional(),
  results: z.array(z.unknown()).optional(),
});

export interface XClientOptions {
  fetch: typeof fetch;
  timeoutMs?: number;
  /** 瞬时 404/5xx 的重试次数；fxtwitter 实测会偶发 404。 */
  retries?: number;
}

export class FxTwitterClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(options: XClientOptions) {
    this.fetchImpl = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retries = options.retries ?? 2;
  }

  /** 最近推文，API 原始顺序（新→旧）；回复/转推过滤交给 domain。 */
  async fetchRecentTweets(handle: string): Promise<Tweet[]> {
    return retry(() => this.fetchOnce(handle), {
      retries: this.retries,
      minTimeout: 400,
      maxTimeout: 2_000,
      factor: 2,
      // 404/429/5xx 是 fxtwitter 的瞬时故障；结构变化（status 200）不重试。
      shouldRetry: ({ error }) => {
        if (error instanceof XApiError) {
          return error.status === 404 || error.status === 429 || error.status >= 500;
        }
        return true;
      },
    });
  }

  private async fetchOnce(handle: string): Promise<Tweet[]> {
    const url = `${BASE_URL}/2/profile/${encodeURIComponent(handle)}/statuses`;
    const response = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new XApiError(`HTTP ${response.status}: ${text.slice(0, 120)}`, response.status);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new XApiError(`响应不是 JSON：${text.slice(0, 120)}`, response.status);
    }

    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) {
      throw new XApiError(
        `响应结构变了：${envelope.error.issues.map((issue) => issue.path.join(".")).join(",")}`,
        response.status,
      );
    }
    if (envelope.data.code !== 200) {
      throw new XApiError(
        `业务错误 ${envelope.data.code}: ${envelope.data.message ?? ""}`,
        envelope.data.code,
      );
    }

    const tweets: Tweet[] = [];
    for (const raw of envelope.data.results ?? []) {
      if ((raw as { type?: unknown }).type !== "status") {
        continue;
      }
      const parsed = statusSchema.safeParse(raw);
      if (!parsed.success) {
        throw new XApiError(
          `status 结构变了：${parsed.error.issues.map((issue) => issue.path.join(".")).join(",")}`,
          response.status,
        );
      }
      const data = parsed.data;
      tweets.push({
        id: data.id,
        text: data.text,
        createdAt: data.created_timestamp * 1000,
        url: data.url ?? `https://x.com/${data.author.screen_name}/status/${data.id}`,
        authorHandle: data.author.screen_name,
        replyTo: data.replying_to?.screen_name ?? null,
        repostedBy: data.reposted_by?.screen_name ?? null,
        media: (data.media?.all ?? []).map((item) => ({ type: item.type })),
      });
    }
    return tweets;
  }
}
