// The panda's conversation state machine. Every visual and every transition in
// the app derives from `status`; side effects live in useConversation.
//
//   idle ──LISTEN──▶ listening ──QUESTION──▶ thinking ──SPEECH_START──▶ speaking
//    ▲                  │ NOTHING_HEARD          │ SPEECH_END             │ SPEECH_END
//    └──────────────────┴────────────────────────┴────────────────────────┘
//   Any state can LISTEN again (interrupting the panda), FAIL to error, or RESET.

export type Phase = "idle" | "listening" | "thinking" | "speaking" | "error";

export interface ConversationState {
  status: Phase;
  /** What the user is saying or said last. */
  transcript: string;
  /** The panda's answer as it streams in. */
  answer: string;
  /** null until the server's topic guard decides. */
  inScope: boolean | null;
  error: string | null;
}

export type ConversationEvent =
  | { type: "LISTEN" }
  | { type: "TRANSCRIPT"; text: string }
  | { type: "NOTHING_HEARD"; error?: string }
  | { type: "QUESTION"; text: string }
  | { type: "VERDICT"; inScope: boolean }
  | { type: "ANSWER_DELTA"; text: string }
  | { type: "SPEECH_START" }
  | { type: "SPEECH_END" }
  | { type: "FAIL"; message: string }
  | { type: "RESET" };

export const initialState: ConversationState = {
  status: "idle",
  transcript: "",
  answer: "",
  inScope: null,
  error: null,
};

export function reduce(state: ConversationState, event: ConversationEvent): ConversationState {
  switch (event.type) {
    case "LISTEN":
      // Allowed from anywhere: talking over the panda interrupts it.
      return { ...initialState, status: "listening" };

    case "TRANSCRIPT":
      return state.status === "listening" ? { ...state, transcript: event.text } : state;

    case "NOTHING_HEARD":
      if (state.status !== "listening") return state;
      return event.error ? { ...initialState, status: "error", error: event.error } : initialState;

    case "QUESTION":
      // From listening (voice) or from any state (typed fallback, which also interrupts).
      return { ...initialState, status: "thinking", transcript: event.text };

    case "VERDICT":
      return state.status === "thinking" || state.status === "speaking" ? { ...state, inScope: event.inScope } : state;

    case "ANSWER_DELTA":
      return state.status === "thinking" || state.status === "speaking"
        ? { ...state, answer: state.answer + event.text }
        : state;

    case "SPEECH_START":
      return state.status === "thinking" ? { ...state, status: "speaking" } : state;

    case "SPEECH_END":
      // Keep the transcript and answer on screen as subtitles until the next question.
      return state.status === "speaking" || state.status === "thinking" ? { ...state, status: "idle" } : state;

    case "FAIL":
      return { ...state, status: "error", error: event.message };

    case "RESET":
      return state.status === "error" ? initialState : state;
  }
}
