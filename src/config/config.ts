/**
 * 配置加载（config/traders.yaml）。用 zod 校验，写错字段启动即失败。
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const traderSchema = z.object({
  id: z.string().min(1),
  portfolioId: z.string().min(5),
  label: z.string().min(1),
  enabled: z.boolean().default(true),
  pollSeconds: z.number().int().min(30).optional(),
  /** X 用户名（不带 @）；填了才会在信号推送成功后附带他的新推文。 */
  xHandle: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,15}$/, "xHandle 只能是 1-15 位字母、数字或下划线")
    .optional(),
  /** 单次最多推送多少条新推文；超出的更早推文跳过。 */
  xMaxTweetsPerPush: z.number().int().min(1).max(50).optional(),
});

const configSchema = z.object({
  pollSeconds: z.number().int().min(30).default(60),
  bootstrapDays: z.number().int().min(1).max(30).default(14),
  push: z.boolean().default(false),
  traders: z.array(traderSchema).min(1),
});

export type TraderConfig = z.infer<typeof traderSchema>;
export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(path: string): AppConfig {
  const raw = parse(readFileSync(path, "utf8")) as unknown;
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`配置校验失败：${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const ids = new Set<string>();
  for (const trader of parsed.data.traders) {
    if (ids.has(trader.id)) {
      throw new Error(`交易员 id 重复：${trader.id}`);
    }
    ids.add(trader.id);
  }
  return parsed.data;
}

export function pollMsOf(config: AppConfig, trader: TraderConfig): number {
  return (trader.pollSeconds ?? config.pollSeconds) * 1000;
}
