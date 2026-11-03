import type { AskRequest } from "../../shared/protocol";
import { DailyLimit, DailyLimitReached } from "../dailyLimit";
import { streamOffline } from "./offline";
import { qwenUnavailability, resolveQwenConfig, streamQwen, type Unavailability } from "./qwen";

export interface Provider {
  /** Shown in the latency panel and the server log. */
  name: string;
  stream(req: AskRequest, signal: AbortSignal): AsyncGenerator<string>;
  /** Whether a failure means "fall through to the next provider", and for how long. */
  unavailability(error: unknown): Unavailability;
}

export type ProviderMode = "auto" | "qwen" | "offline";
const MODES: readonly ProviderMode[] = ["auto", "qwen", "offline"];

/** Questions per day sent to Qwen when QWEN_DAILY_LIMIT is not set. */
export const DEFAULT_DAILY_LIMIT = 100;
const USAGE_FILE = ".qwen-usage.json";

export const offlineProvider: Provider = {
  name: "offline",
  stream: streamOffline,
  unavailability: () => null,
};

function qwenProvider(env: NodeJS.ProcessEnv, usageFile: string): Provider | null {
  const config = resolveQwenConfig(env);
  if (!config) return null;
  const limit = new DailyLimit(dailyLimit(env), usageFile);
  return {
    name: config.name,
    async *stream(req, signal) {
      if (!limit.take()) throw new DailyLimitReached(limit.max);
      yield* streamQwen(config, req, signal);
    },
    // Today's limit only skips Qwen until the date changes.
    unavailability: (error) => (error instanceof DailyLimitReached ? "temporary" : qwenUnavailability(error)),
  };
}

function dailyLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.QWEN_DAILY_LIMIT?.trim();
  if (!raw) return DEFAULT_DAILY_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`QWEN_DAILY_LIMIT must be a whole number (0 for no limit), not "${raw}".`);
  return value;
}

/**
 * Providers to try in order for PANDA_PROVIDER:
 * - auto: Qwen Flash when LLM_API_KEY is set, then the offline knowledge base
 * - qwen: only Qwen (errors surface instead of falling back)
 * - offline: the built-in knowledge base only
 */
export function providerChain(env: NodeJS.ProcessEnv, usageFile = USAGE_FILE): { mode: ProviderMode; chain: Provider[] } {
  const mode = MODES.find((m) => m === env.PANDA_PROVIDER) ?? "auto";
  const qwen = qwenProvider(env, usageFile);

  switch (mode) {
    case "offline":
      return { mode, chain: [offlineProvider] };
    case "qwen":
      if (!qwen) throw new Error("PANDA_PROVIDER=qwen needs LLM_API_KEY.");
      return { mode, chain: [qwen] };
    case "auto":
      return { mode, chain: [...(qwen ? [qwen] : []), offlineProvider] };
  }
}
