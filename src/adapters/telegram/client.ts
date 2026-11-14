/**
 * Telegram 发送（docs/spec.md §9）。
 *
 * 只重试「明确没送达」的错误：429 和请求发出前的连接失败。
 * 超时/连接重置/5xx 结果不确定，不重试，交给下一轮的 outbox 补发（按信号去重）。
 */

export interface TelegramResult {
  messageId: number | null;
}

export class TelegramError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TelegramError";
    this.status = status;
  }

  /** 4xx（除 429）是永久错误：chat_id 错、被踢、文本超长，重试无用。 */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

export interface TelegramOptions {
  token: string;
  chatId: string;
  fetch: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class TelegramClient {
  private readonly baseUrl: string;

  constructor(private readonly options: TelegramOptions) {
    this.baseUrl = `https://api.telegram.org/bot${options.token}`;
  }

  async sendMessage(text: string): Promise<TelegramResult> {
    const maxAttempts = this.options.maxAttempts ?? 3;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.options.fetch(`${this.baseUrl}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: this.options.chatId,
            text,
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        });
      } catch (error) {
        const code = (error as { cause?: { code?: string } }).cause?.code;
        if (attempt < maxAttempts && code && NOT_SENT_CODES.has(code)) {
          await sleep(attempt * 1000);
          continue;
        }
        throw error;
      }

      if (response.status === 429 && attempt < maxAttempts) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "1");
        await sleep(Math.min(30, retryAfter) * 1000);
        continue;
      }

      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
        result?: { message_id?: number };
      };
      if (!response.ok || body.ok !== true) {
        throw new TelegramError(`Telegram ${response.status}: ${body.description ?? "unknown"}`, response.status);
      }
      return { messageId: body.result?.message_id ?? null };
    }
  }
}
