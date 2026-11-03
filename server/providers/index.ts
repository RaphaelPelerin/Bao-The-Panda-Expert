import type { AskRequest, QwenRegion } from "../../shared/protocol";
import { qwenConfig, qwenUnavailability, streamQwen, type Unavailability } from "./qwen";

export interface Provider {
  /** Shown in the latency panel and the server log. */
  name: string;
  stream(req: AskRequest, signal: AbortSignal): AsyncGenerator<string>;
  unavailability(error: unknown): Unavailability;
}

/** Only provider: locked qwen-flash-character on the chosen DashScope region. */
export function makeQwenProvider(apiKey: string, region: QwenRegion = "qwen-intl"): Provider {
  const config = qwenConfig(apiKey, region);
  return {
    name: config.name,
    stream: (req, signal) => streamQwen(config, req, signal),
    unavailability: qwenUnavailability,
  };
}
