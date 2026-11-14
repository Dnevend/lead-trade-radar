/**
 * 预览 X 推文：`npm run tweets [-- handle] [-- --count=5]`。
 * 只读取，不写库、不发 Telegram；用于上线前确认数据源和文案。
 */

import { fileURLToPath } from "node:url";
import { FxTwitterClient } from "../adapters/x/client.ts";
import { loadConfig } from "../config/config.ts";
import { renderTweetDigest } from "../domain/render.ts";
import { eligibleTweets, newTweetsSince } from "../domain/tweet.ts";

const ROOT = process.env.RADAR_ROOT ?? fileURLToPath(new URL("../..", import.meta.url));
const configPath = process.env.CONFIG_PATH ?? `${ROOT}/config/traders.yaml`;

const args = process.argv.slice(2);
const handleArg = args.find((arg) => !arg.startsWith("--"));
const countArg = args.find((arg) => arg.startsWith("--count="));
const count = countArg ? Number(countArg.slice("--count=".length)) : 5;
if (!Number.isInteger(count) || count < 1 || count > 50) {
  throw new Error("--count 必须是 1-50 的整数");
}

const config = loadConfig(configPath);
const configured = config.traders.find((trader) => trader.enabled && trader.xHandle);
const handle = handleArg ?? configured?.xHandle;
if (!handle) {
  throw new Error("配置里没有启用的 xHandle，也没有在命令行传入 handle");
}
const label = configured?.xHandle?.toLowerCase() === handle.toLowerCase() ? configured.label : handle;

const client = new FxTwitterClient({ fetch });
const all = await client.fetchRecentTweets(handle);
const eligible = eligibleTweets(all, handle);
const { selected } = newTweetsSince(eligible, null, count);
const messages = renderTweetDigest({ label, handle, tweets: selected });

console.log(`@${handle}：接口返回 ${all.length} 条，原创/自引 ${eligible.length} 条，本次展示 ${selected.length} 条\n`);
if (messages.length === 0) {
  console.log("（没有可展示的推文）");
} else {
  for (const message of messages) {
    console.log(message.text);
    console.log("---");
  }
}
