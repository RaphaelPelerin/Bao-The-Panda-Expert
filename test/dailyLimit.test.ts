import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DailyLimit, DailyLimitReached } from "../server/dailyLimit";
import { providerChain } from "../server/providers";

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
  it("allows max questions a day, then refuses until the next day", () => {
    let now = new Date(2026, 10, 3, 23, 0);
    const file = usageFile();
    const limit = new DailyLimit(2, file, () => now);
    expect([limit.take(), limit.take(), limit.take()]).toEqual([true, true, false]);
    expect(limit.used).toBe(2);
    now = new Date(2026, 10, 4, 0, 5);
    expect(limit.take()).toBe(true);
    expect(limit.used).toBe(1);
  });

  it("survives a restart", () => {
    const file = usageFile();
    const today = () => new Date(2026, 10, 3, 12);
    new DailyLimit(5, file, today).take();
    expect(new DailyLimit(5, file, today).used).toBe(1);
  });

  it("has no limit at 0", () => {
    const limit = new DailyLimit(0, usageFile());
    for (let i = 0; i < 50; i++) expect(limit.take()).toBe(true);
  });

  it("makes Qwen fall back to offline for the question once reached", async () => {
    const [qwen] = providerChain({ LLM_API_KEY: "k", QWEN_DAILY_LIMIT: "0" }, usageFile()).chain;
    expect(qwen.unavailability(new DailyLimitReached(1))).toBe("temporary");

    const file = usageFile();
    new DailyLimit(1, file).take();
    const [limited] = providerChain({ LLM_API_KEY: "k", QWEN_DAILY_LIMIT: "1" }, file).chain;
    const stream = limited.stream({ question: "Hi", lang: "en", history: [] }, new AbortController().signal);
    await expect(stream.next()).rejects.toBeInstanceOf(DailyLimitReached);
  });

  it("rejects a bad setting", () => {
    expect(() => providerChain({ LLM_API_KEY: "k", QWEN_DAILY_LIMIT: "lots" }, usageFile())).toThrow(/QWEN_DAILY_LIMIT/);
  });
});
