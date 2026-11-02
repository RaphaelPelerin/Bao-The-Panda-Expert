// Wire format between the browser and /api/ask. Shared by client and server.

export type Lang = "en" | "fr";

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
  | { type: "verdict"; inScope: boolean; provider: "claude" | "offline" }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export const MAX_QUESTION_CHARS = 500;
export const MAX_HISTORY_TURNS = 6;
