import { readFileSync, writeFileSync } from "node:fs";
import type { Usage } from "../shared/protocol.js";

/** Where today's question count lives. */
export interface UsageStore {
  read(day: string): Promise<number>;
  increment(day: string): Promise<number>;
}

/** One file, so a server restart doesn't reset the count. Fine for a single server. */
export function fileStore(file: string): UsageStore {
  const load = (day: string): number => {
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as { date?: string; count?: number };
      if (data.date === day && Number.isInteger(data.count)) return data.count!;
    } catch {
      // No file yet, or unreadable: start the day at zero.
    }
    return 0;
  };
  return {
    read: async (day) => load(day),
    increment: async (day) => {
      const count = load(day) + 1;
      writeFileSync(file, JSON.stringify({ date: day, count }));
      return count;
    },
  };
}

const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;

/** Upstash Redis over its REST API. Shared by every serverless instance, and INCR can't lose a count. */
export function redisStore(url: string, token: string, request: typeof fetch = fetch): UsageStore {
  const command = async (...args: (string | number)[]): Promise<unknown> => {
    const response = await request(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`Usage store answered ${response.status}`);
    return ((await response.json()) as { result: unknown }).result;
  };
  const key = (day: string) => `bao:questions:${day}`;
  return {
    read: async (day) => Number((await command("GET", key(day))) ?? 0),
    increment: async (day) => {
      const count = Number(await command("INCR", key(day)));
      if (count === 1) await command("EXPIRE", key(day), TWO_DAYS_SECONDS);
      return count;
    },
  };
}

/** Counts the questions sent to the LLM per day. A max of 0 means no limit. */
export class DailyLimit {
  constructor(
    readonly max: number,
    private readonly store: UsageStore,
    /** True when the count isn't shared between server instances, so it can't be trusted exactly. */
    private readonly approximate = false,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Uses one question; refused once today's limit is reached. */
  async take(): Promise<{ allowed: boolean; usage: Usage }> {
    const day = dayKey(this.now());
    if (this.max > 0 && (await this.store.read(day)) >= this.max) {
      return { allowed: false, usage: this.report(this.max) };
    }
    const count = await this.store.increment(day);
    // Two requests can pass the check at once; the atomic count settles it.
    const allowed = this.max === 0 || count <= this.max;
    return { allowed, usage: this.report(this.max > 0 ? Math.min(count, this.max) : count) };
  }

  async usage(): Promise<Usage> {
    return this.report(await this.store.read(dayKey(this.now())));
  }

  private report(used: number): Usage {
    return { used, max: this.max, approximate: this.approximate };
  }
}

/** Builds the limit from the environment: Redis when connected, otherwise a file. */
export function createDailyLimit(env: NodeJS.ProcessEnv): DailyLimit {
  const parsed = Number(env.QWEN_DAILY_LIMIT);
  const max = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return new DailyLimit(max, redisStore(url, token));
  // Vercel only allows writing to /tmp, and each instance has its own.
  return env.VERCEL ? new DailyLimit(max, fileStore("/tmp/bao-usage.json"), true) : new DailyLimit(max, fileStore(".qwen-usage.json"));
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
