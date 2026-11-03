import OpenAI from "openai";
import type { AskRequest } from "../../shared/protocol";
import { LANGUAGE_HINT, SYSTEM_PROMPT } from "../prompt";

// Qwen Flash on Alibaba Cloud Model Studio (free quota), through its
// OpenAI-compatible endpoint.

export interface QwenConfig {
  /** Region name, shown in the latency panel. */
  name: string;
  apiKey: string;
  baseURL: string;
  model: string;
  extraBody?: Record<string, unknown>;
}

// The role-play variant of Qwen Flash: it has the account's free quota, and
// suits a character who stays in voice.
const MODEL = "qwen-flash-character";

// Short factual answers need no reasoning, so thinking mode is switched off
// explicitly: it would only add latency.
const NO_THINKING = { enable_thinking: false };

// The region is where the account was created; only the server calls it, so
// visitors' location does not matter.
const REGIONS: Record<string, string> = {
  "qwen-intl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
};
const DEFAULT_REGION = "qwen-intl";

/** Reads LLM_API_KEY and LLM_PROVIDER (the region). Returns null without a key. */
export function resolveQwenConfig(env: NodeJS.ProcessEnv): QwenConfig | null {
  const apiKey = env.LLM_API_KEY?.trim();
  if (!apiKey) return null;

  const name = env.LLM_PROVIDER?.trim().toLowerCase() || DEFAULT_REGION;
  const baseURL = REGIONS[name];
  if (!baseURL) throw new Error(`LLM_PROVIDER must be ${Object.keys(REGIONS).join(" or ")}, not "${name}".`);
  return { name, apiKey, baseURL, model: MODEL, extraBody: NO_THINKING };
}

const clients = new Map<string, OpenAI>();
function getClient(config: QwenConfig): OpenAI {
  const key = `${config.baseURL}|${config.apiKey}`;
  let client = clients.get(key);
  if (!client) {
    client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 1, timeout: 20_000 });
    clients.set(key, client);
  }
  return client;
}

/** Streams the raw model text, [IN]/[OUT] tag included. */
export async function* streamQwen(config: QwenConfig, req: AskRequest, signal: AbortSignal): AsyncGenerator<string> {
  const stream = await getClient(config).chat.completions.create(
    {
      model: config.model,
      stream: true,
      // Short spoken answers; a low temperature keeps the [IN]/[OUT] tag reliable.
      max_tokens: 400,
      temperature: 0.3,
      messages: [
        { role: "system", content: `${SYSTEM_PROMPT}\n\n${LANGUAGE_HINT[req.lang]}` },
        ...req.history.map((turn) => ({ role: turn.role, content: turn.text })),
        { role: "user", content: req.question },
      ],
      ...config.extraBody,
    },
    { signal },
  );

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) yield text;
  }
}

export type Unavailability = "permanent" | "temporary" | null;

/**
 * Whether an error means "answer offline instead". Bad credentials and network
 * failures are permanent for this server run; an exhausted free quota (the
 * daily limit) only skips Qwen for the current question, so it comes back by itself.
 */
export function qwenUnavailability(error: unknown): Unavailability {
  if (
    error instanceof OpenAI.AuthenticationError ||
    error instanceof OpenAI.PermissionDeniedError ||
    error instanceof OpenAI.APIConnectionError ||
    // Model Studio not activated, model not allowed for this key, or free quota
    // used up with "Free Quota Only" on (AllocationQuota.FreeTierOnly). Some come as 400.
    (error instanceof OpenAI.APIError && /^(AccessDenied|AllocationQuota)/.test(String(error.code ?? "")))
  ) {
    return "permanent";
  }
  // 402: out of balance. 429: rate limit or free quota used up.
  if (error instanceof OpenAI.RateLimitError || (error instanceof OpenAI.APIError && error.status === 402)) {
    return "temporary";
  }
  return null;
}
