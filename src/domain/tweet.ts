/**
 * X 推文（docs/spec.md §6.1）：只做筛选、排序和游标比较，不含任何 I/O。
 *
 * 推文 ID 是 19 位十进制数，超出 JS 安全整数范围（2^53），全程按字符串保存、
 * 用 BigInt 比较；任何地方都不能先转成 number 再比较，否则会丢精度。
 */

export interface TweetMedia {
  /** fxtwitter 的媒体类型：photo / video / gif 等。 */
  type: string;
}

export interface Tweet {
  id: string;
  text: string;
  /** 发布时间（UTC 毫秒）。 */
  createdAt: number;
  url: string;
  authorHandle: string;
  /** 回复对象的用户名；原创为 null。 */
  replyTo: string | null;
  /** 被转推的原作者；非转推为 null。 */
  repostedBy: string | null;
  media: TweetMedia[];
}

/** 推文数据源；生产实现见 adapters/x/client.ts，测试注入假实现。 */
export interface TweetSource {
  fetchRecentTweets(handle: string): Promise<Tweet[]>;
}

/** 推文 ID 比较；解析失败时退回字典序，保证不会抛错。 */
export function compareTweetIds(a: string, b: string): number {
  try {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  } catch {
    return a.localeCompare(b);
  }
}

export function newestTweetId(tweets: Tweet[]): string | null {
  let newest: string | null = null;
  for (const tweet of tweets) {
    if (newest === null || compareTweetIds(tweet.id, newest) > 0) {
      newest = tweet.id;
    }
  }
  return newest;
}

/**
 * 只保留原创和自引线程：他自己的帖子、他自己接续的补充帖。
 * 转推（repostedBy 非空）和他对别人的回复都排除，避免带出无关节奏。
 */
export function eligibleTweets(tweets: Tweet[], handle: string): Tweet[] {
  const target = handle.toLowerCase();
  return tweets.filter(
    (tweet) =>
      tweet.authorHandle.toLowerCase() === target &&
      tweet.repostedBy === null &&
      (tweet.replyTo === null || tweet.replyTo.toLowerCase() === target),
  );
}

export interface TweetSelection {
  /** 按时间升序，便于从旧到新阅读。 */
  selected: Tweet[];
  /** 超过单次上限、被跳过的更早推文条数。 */
  skipped: number;
}

/**
 * cursor 之后的新推文；同一 ID 只保留一条。
 * 超过 max 时保留**最新**的 max 条——信号发生时，几天前的旧推文已经失去上下文价值。
 */
export function newTweetsSince(tweets: Tweet[], cursor: string | null, max: number): TweetSelection {
  const byId = new Map<string, Tweet>();
  for (const tweet of tweets) {
    if (cursor !== null && compareTweetIds(tweet.id, cursor) <= 0) {
      continue;
    }
    byId.set(tweet.id, tweet);
  }
  const fresh = [...byId.values()].sort((a, b) => compareTweetIds(a.id, b.id));
  if (fresh.length <= max) {
    return { selected: fresh, skipped: 0 };
  }
  return { selected: fresh.slice(-max), skipped: fresh.length - max };
}
