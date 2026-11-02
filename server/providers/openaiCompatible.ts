import OpenAI from "openai";
import type { AskRequest } from "../../shared/protocol";
import { LANGUAGE_HINT, SYSTEM_PROMPT } from "../prompt";

// Any provider that speaks the OpenAI chat-completions format: DeepSeek, Qwen
// (Alibaba Cloud Model Studio), Kimi, GLM, Groq… Presets cover the common ones;
// LLM_BASE_URL and LLM_MODEL override them.

export interface LlmConfig {
  /** Preset name, shown in the latency panel. */
  name: string;
  apiKey: string;
  baseURL: string;
  model: string;
  extraBody?: Record<string, unknown>;
}

interface Preset {
  baseURL: string;
  model: string;
  /** Provider-specific request fields. */
  extraBody?: Record<string, unknown>;
}

// Short factual answers need no reasoning, so Qwen's thinking mode is switched
// off explicitly: it would only add latency.
const QWEN_FAST = { enable_thinking: false };

const PRESETS: Record<string, Preset> = {
  // Alibaba Cloud Model Studio. The region is where the account was created;
  // only the server calls it, so visitors' location does not matter.
  "qwen-intl": { baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "qwen-flash", extraBody: QWEN_FAST },
  qwen: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-flash", extraBody: QWEN_FAST },
  deepseek: { baseURL: "https://api.deepseek.com", model: "deepseek-chat" },
};
const DEFAULT_PRESET = "qwen-intl";

/** Reads the LLM_* variables. Returns null when no OpenAI-compatible provider is configured. */
export function resolveLlmConfig(env: NodeJS.ProcessEnv): LlmConfig | null {
  const apiKey = env.LLM_API_KEY?.trim();
  if (!apiKey) return null;

  const name = env.LLM_PROVIDER?.trim().toLowerCase() || DEFAULT_PRESET;
  const preset = PRESETS[name];
  const baseURL = env.LLM_BASE_URL?.trim() || preset?.baseURL;
  const model = env.LLM_MODEL?.trim() || preset?.model;
  if (!baseURL || !model) {
    throw new Error(`LLM_PROVIDER "${name}" has no preset: set LLM_BASE_URL and LLM_MODEL (presets: ${Object.keys(PRESETS).join(", ")}).`);
  }
  return { name, apiKey, baseURL, model, extraBody: preset?.extraBody };
}

const clients = new Map<string, OpenAI>();
function getClient(config: LlmConfig): OpenAI {
  const key = `${config.baseURL}|${config.apiKey}`;
  let client = clients.get(key);
  if (!client) {
    client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 1, timeout: 20_000 });
    clients.set(key, client);
  }
  return client;
}

/** Streams the raw model text (tag included), like streamClaude. */
export async function* streamOpenAICompatible(config: LlmConfig, req: AskRequest, signal: AbortSignal): AsyncGenerator<string> {
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
 * Whether an error means "use another provider". Bad credentials and network
 * failures are permanent for this server run; an exhausted free quota or
 * balance only skips the provider for the current question.
 */
export function openAICompatibleUnavailability(error: unknown): Unavailability {
  if (
    error instanceof OpenAI.AuthenticationError ||
    error instanceof OpenAI.PermissionDeniedError ||
    error instanceof OpenAI.APIConnectionError
  ) {
    return "permanent";
  }
  // 402: DeepSeek's "insufficient balance". 429: rate limit or free quota used up.
  if (error instanceof OpenAI.RateLimitError || (error instanceof OpenAI.APIError && error.status === 402)) {
    return "temporary";
  }
  return null;
}
