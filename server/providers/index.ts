import type { AskRequest } from "../../shared/protocol";
import { isClaudeUnavailable, streamClaude } from "./claude";
import { streamOffline } from "./offline";
import { openAICompatibleUnavailability, resolveLlmConfig, streamOpenAICompatible, type Unavailability } from "./openaiCompatible";

export interface Provider {
  /** Shown in the latency panel and the server log. */
  name: string;
  stream(req: AskRequest, signal: AbortSignal): AsyncGenerator<string>;
  /** Whether a failure means "fall through to the next provider", and for how long. */
  unavailability(error: unknown): Unavailability;
}

export type ProviderMode = "auto" | "openai" | "claude" | "offline";
const MODES: readonly ProviderMode[] = ["auto", "openai", "claude", "offline"];

export const offlineProvider: Provider = {
  name: "offline",
  stream: streamOffline,
  unavailability: () => null,
};

function openAICompatibleProvider(env: NodeJS.ProcessEnv): Provider | null {
  const config = resolveLlmConfig(env);
  if (!config) return null;
  return {
    name: config.name,
    stream: (req, signal) => streamOpenAICompatible(config, req, signal),
    unavailability: openAICompatibleUnavailability,
  };
}

const claudeProvider: Provider = {
  name: "claude",
  stream: streamClaude,
  unavailability: (error) => (isClaudeUnavailable(error) ? "permanent" : null),
};

/**
 * Providers to try in order for PANDA_PROVIDER:
 * - auto: the OpenAI-compatible provider when LLM_API_KEY is set, then Claude, then offline
 * - openai / claude: only that provider (errors surface instead of falling back)
 * - offline: the built-in knowledge base only
 */
export function providerChain(env: NodeJS.ProcessEnv): { mode: ProviderMode; chain: Provider[] } {
  const mode = MODES.find((m) => m === env.PANDA_PROVIDER) ?? "auto";
  const compatible = openAICompatibleProvider(env);

  switch (mode) {
    case "offline":
      return { mode, chain: [offlineProvider] };
    case "claude":
      return { mode, chain: [claudeProvider] };
    case "openai":
      if (!compatible) throw new Error("PANDA_PROVIDER=openai needs LLM_API_KEY.");
      return { mode, chain: [compatible] };
    case "auto":
      return { mode, chain: [...(compatible ? [compatible] : []), claudeProvider, offlineProvider] };
  }
}
