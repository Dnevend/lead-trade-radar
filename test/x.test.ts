import { describe, expect, it } from "vitest";
import { FxTwitterClient, XApiError } from "../src/adapters/x/client.ts";
import { loadXStatuses } from "./helpers.ts";

function clientWith(payload: unknown, status = 200, retries = 0): FxTwitterClient {
  return new FxTwitterClient({
    fetch: async () => new Response(JSON.stringify(payload), { status }),
    retries,
  });
}

describe("X 推文适配器", () => {
  it("解析最新推文、媒体、自引回复和转推标记", async () => {
    const client = clientWith(loadXStatuses());
    const tweets = await client.fetchRecentTweets("thankUcrypto");
    expect(tweets).toHaveLength(6);

    const byId = new Map(tweets.map((tweet) => [tweet.id, tweet]));
    const newest = byId.get("2121593758101942747")!;
    expect(newest.text).toContain("周末的暴跌可以抄");
    expect(newest.createdAt).toBe(1_794_662_343_000);
    expect(newest.authorHandle).toBe("thankUcrypto");
    expect(newest.replyTo).toBeNull();
    expect(newest.repostedBy).toBeNull();

    const withMedia = byId.get("2121443348506681423")!;
    expect(withMedia.media).toEqual([{ type: "photo" }, { type: "photo" }]);

    expect(byId.get("2121079891747860719")!.replyTo).toBe("thankUcrypto");
    expect(byId.get("2121262873599177091")!.replyTo).toBe("0xajc");

    const repost = byId.get("2120490938711851446")!;
    expect(repost.authorHandle).toBe("heyibinance");
    expect(repost.repostedBy).toBe("thankUcrypto");
  });

  it("HTTP 错误和业务错误都抛 XApiError", async () => {
    await expect(clientWith({}, 503).fetchRecentTweets("thankUcrypto")).rejects.toBeInstanceOf(XApiError);
    await expect(
      clientWith({ code: 404, message: "user not found" }).fetchRecentTweets("nobody"),
    ).rejects.toThrow("业务错误 404");
  });

  it("瞬时 404 自动重试，第二次成功", async () => {
    let calls = 0;
    const client = new FxTwitterClient({
      retries: 2,
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ code: 404, results: [] }), { status: 404 });
        }
        return new Response(JSON.stringify(loadXStatuses()), { status: 200 });
      },
    });
    const tweets = await client.fetchRecentTweets("thankUcrypto");
    expect(calls).toBe(2);
    expect(tweets).toHaveLength(6);
  });

  it("status 字段缺失时报结构变化", async () => {
    const payload = { code: 200, results: [{ type: "status", id: "1", text: "x" }] };
    await expect(clientWith(payload).fetchRecentTweets("thankUcrypto")).rejects.toThrow("status 结构变了");
  });

  it("非 status 条目直接跳过", async () => {
    const payload = {
      code: 200,
      results: [
        { type: "user", id: "1" },
        {
          type: "status",
          id: "2121593758101942747",
          text: "hi",
          created_timestamp: 1_794_662_343,
          url: "https://x.com/thankUcrypto/status/2121593758101942747",
          author: { screen_name: "thankUcrypto" },
        },
      ],
    };
    const tweets = await clientWith(payload).fetchRecentTweets("thankUcrypto");
    expect(tweets).toHaveLength(1);
    expect(tweets[0]!.replyTo).toBeNull();
    expect(tweets[0]!.media).toEqual([]);
  });
});
