// Wire format between the browser and /api/ask. Shared by client and server.

export const LANGS = ["en", "fr", "zh"] as const;
export type Lang = (typeof LANGS)[number];

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

/** Fixed answer model — never taken from the client or env. */
export const QWEN_MODEL = "qwen-flash-character" as const;

/** DashScope endpoint region (account location). Does not change the model. */
export const QWEN_REGIONS = ["qwen-intl", "qwen"] as const;
export type QwenRegion = (typeof QWEN_REGIONS)[number];

export function isQwenRegion(value: unknown): value is QwenRegion {
  return typeof value === "string" && (QWEN_REGIONS as readonly string[]).includes(value);
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface AskRequest {
  question: string;
  lang: Lang;
  /** Recent turns, oldest first, so follow-ups like "and how long do they live?" resolve. */
  history: Turn[];
}

/** Server-sent events, one JSON object per `data:` line. */
export type AskEvent =
  /** Sent once the topic guard has decided. `inScope: false` means `text` deltas carry the refusal. */
  | { type: "verdict"; inScope: boolean; provider: string }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export const MAX_QUESTION_CHARS = 500;
export const MAX_HISTORY_TURNS = 6;
