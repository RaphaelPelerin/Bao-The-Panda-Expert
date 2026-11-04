import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDailyLimit, DailyLimit, fileStore, redisStore } from "../server/dailyLimit";

const dirs: string[] = [];
function usageFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "panda-usage-"));
  dirs.push(dir);
  return join(dir, "usage.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("daily limit", () => {
  it("allows max questions a day, then refuses until the next day", async () => {
    let now = new Date(Date.UTC(2026, 10, 3, 23));
    const limit = new DailyLimit(2, fileStore(usageFile()), false, () => now);
    const allowed = [];
    for (let i = 0; i < 3; i++) allowed.push((await limit.take()).allowed);
    expect(allowed).toEqual([true, true, false]);
    expect(await limit.usage()).toEqual({ used: 2, max: 2, approximate: false });
    now = new Date(Date.UTC(2026, 10, 4, 0, 5));
    expect((await limit.take()).allowed).toBe(true);
    expect((await limit.usage()).used).toBe(1);
  });

  it("survives a restart", async () => {
    const file = usageFile();
    const today = () => new Date(Date.UTC(2026, 10, 3, 12));
    await new DailyLimit(5, fileStore(file), false, today).take();
    expect((await new DailyLimit(5, fileStore(file), false, today).usage()).used).toBe(1);
  });

  it("has no limit at 0, but still counts", async () => {
    const limit = new DailyLimit(0, fileStore(usageFile()));
    for (let i = 0; i < 50; i++) expect((await limit.take()).allowed).toBe(true);
    expect((await limit.usage()).used).toBe(50);
  });

  it("refuses when concurrent requests pass the check together", async () => {
    let count = 1;
    const store = { read: async () => 1, increment: async () => ++count };
    const result = await new DailyLimit(2, store).take();
    expect(result.allowed).toBe(true);
    expect((await new DailyLimit(2, store).take()).allowed).toBe(false);
  });
});

describe("usage stores", () => {
  it("talks to Redis over REST and expires old days", async () => {
    const commands: unknown[] = [];
    const replies = [null, 1, 1];
    const fake = (async (_url: string, init: RequestInit) => {
      commands.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ result: replies.shift() }));
    }) as unknown as typeof fetch;
    const store = redisStore("https://redis.test", "token", fake);
    expect(await store.read("2026-11-04")).toBe(0);
    expect(await store.increment("2026-11-04")).toBe(1);
    expect(commands[0]).toEqual(["GET", "bao:questions:2026-11-04"]);
    expect(commands[1]).toEqual(["INCR", "bao:questions:2026-11-04"]);
    expect(commands[2]).toEqual(["EXPIRE", "bao:questions:2026-11-04", 172800]);
  });

  it("surfaces store errors, so callers can decide", async () => {
    const fake = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(redisStore("https://redis.test", "token", fake).read("d")).rejects.toThrow("500");
  });

  it("marks the count as approximate on Vercel without a shared store", async () => {
    const limit = createDailyLimit({ VERCEL: "1", QWEN_DAILY_LIMIT: "10" } as NodeJS.ProcessEnv);
    expect(limit.max).toBe(10);
    expect((await limit.usage()).approximate).toBe(true);
  });

  it("treats a missing or invalid limit as no limit", () => {
    expect(createDailyLimit({ QWEN_DAILY_LIMIT: "abc" } as NodeJS.ProcessEnv).max).toBe(0);
    expect(createDailyLimit({} as NodeJS.ProcessEnv).max).toBe(0);
  });
});
