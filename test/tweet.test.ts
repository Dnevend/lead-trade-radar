import { describe, expect, it } from "vitest";
import { compareTweetIds, eligibleTweets, newestTweetId, newTweetsSince, type Tweet } from "../src/domain/tweet.ts";

function tweet(id: string, text = `tweet ${id}`): Tweet {
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

describe("推文筛选与游标", () => {
  it("推文 ID 超出 JS 安全整数时仍能正确比较", () => {
    const a = "2121593758101942747";
    const b = "2121593758101942748";
    expect(Number(a)).toBe(Number(b)); // 转 number 会丢精度，所以全程用 BigInt
    expect(compareTweetIds(a, b)).toBe(-1);
    expect(compareTweetIds(b, a)).toBe(1);
    expect(compareTweetIds(a, a)).toBe(0);
  });

  it("只保留原创和自引线程", () => {
    const tweets = [
      tweet("1"),
      { ...tweet("2"), replyTo: "thankUcrypto" },
      { ...tweet("3"), replyTo: "someone" },
      { ...tweet("4"), repostedBy: "thankUcrypto" },
      { ...tweet("5"), authorHandle: "someone" },
    ];
    expect(eligibleTweets(tweets, "thankUcrypto").map((item) => item.id)).toEqual(["1", "2"]);
    expect(eligibleTweets(tweets, "ThankUcrypto").map((item) => item.id)).toEqual(["1", "2"]);
  });

  it("只取游标之后，按时间升序，超过上限保留最新", () => {
    const tweets = [tweet("5"), tweet("3"), tweet("4"), tweet("1"), tweet("2")];
    expect(newestTweetId(tweets)).toBe("5");
    expect(newestTweetId([])).toBeNull();

    const all = newTweetsSince(tweets, "0", 10);
    expect(all.selected.map((item) => item.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(all.skipped).toBe(0);

    const capped = newTweetsSince(tweets, "0", 2);
    expect(capped.selected.map((item) => item.id)).toEqual(["4", "5"]);
    expect(capped.skipped).toBe(3);

    const fresh = newTweetsSince(tweets, "3", 10);
    expect(fresh.selected.map((item) => item.id)).toEqual(["4", "5"]);

    // 同一 ID 重复出现只算一次
    expect(newTweetsSince([tweet("7"), tweet("7")], "0", 10).selected).toHaveLength(1);
  });
});
