import OpenAI from "openai";
import { QWEN_MODEL, type AskRequest, type QwenRegion } from "../../shared/protocol";
import { LANGUAGE_HINT, SYSTEM_PROMPT } from "../prompt";

// Qwen Flash Character on Alibaba Cloud Model Studio, through its
// OpenAI-compatible endpoint. Model id is fixed in shared/protocol.ts.

export interface QwenConfig {
  /** Region name, shown in the latency panel. */
  name: QwenRegion;
  apiKey: string;
  baseURL: string;
  /** Always qwen-flash-character. */
  model: typeof QWEN_MODEL;
  extraBody?: Record<string, unknown>;
}

// Short factual answers need no reasoning, so thinking mode is switched off
// explicitly: it would only add latency.
const NO_THINKING = { enable_thinking: false };

const REGIONS: Record<QwenRegion, string> = {
  "qwen-intl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
};

/** Builds a config for the locked model. Region only selects the DashScope host. */
export function qwenConfig(apiKey: string, region: QwenRegion = "qwen-intl"): QwenConfig {
  const key = apiKey.trim();
  if (!key) throw new Error("Missing API key");
  return {
    name: region,
    apiKey: key,
    baseURL: REGIONS[region],
    model: QWEN_MODEL,
    extraBody: NO_THINKING,
  };
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
 * Classifies Qwen/DashScope failures for logging. There is no offline fallback:
 * errors surface to the client.
 */
export function qwenUnavailability(error: unknown): Unavailability {
  if (
    error instanceof OpenAI.AuthenticationError ||
    error instanceof OpenAI.PermissionDeniedError ||
    error instanceof OpenAI.APIConnectionError ||
    (error instanceof OpenAI.APIError && /^(AccessDenied|AllocationQuota)/.test(String(error.code ?? "")))
  ) {
    return "permanent";
  }
  if (error instanceof OpenAI.RateLimitError || (error instanceof OpenAI.APIError && error.status === 402)) {
    return "temporary";
  }
  return null;
}
