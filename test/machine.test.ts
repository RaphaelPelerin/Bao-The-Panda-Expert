import { describe, expect, it } from "vitest";
import { initialState, reduce, type ConversationEvent, type ConversationState } from "../src/state/machine";

const run = (events: ConversationEvent[], from: ConversationState = initialState) => events.reduce(reduce, from);

describe("conversation state machine", () => {
  it("goes through a full voice exchange and back to idle", () => {
    const listening = run([{ type: "LISTEN" }, { type: "TRANSCRIPT", text: "What do pan" }]);
    expect(listening).toMatchObject({ status: "listening", transcript: "What do pan" });

    const thinking = run([{ type: "QUESTION", text: "What do pandas eat?" }, { type: "VERDICT", inScope: true }], listening);
    expect(thinking).toMatchObject({ status: "thinking", transcript: "What do pandas eat?", inScope: true });

    const speaking = run([{ type: "ANSWER_DELTA", text: "Bamboo" }, { type: "SPEECH_START" }, { type: "ANSWER_DELTA", text: "!" }], thinking);
    expect(speaking).toMatchObject({ status: "speaking", answer: "Bamboo!" });

    const done = reduce(speaking, { type: "SPEECH_END" });
    // Back to idle, keeping the last exchange visible as subtitles.
    expect(done).toMatchObject({ status: "idle", answer: "Bamboo!", transcript: "What do pandas eat?" });
  });

  it("lets the user interrupt the panda by listening again", () => {
    const speaking = run([{ type: "QUESTION", text: "q" }, { type: "SPEECH_START" }]);
    expect(reduce(speaking, { type: "LISTEN" })).toEqual({ ...initialState, status: "listening" });
  });

  it("returns to idle when nothing was heard, or shows a microphone error", () => {
    const listening = reduce(initialState, { type: "LISTEN" });
    expect(reduce(listening, { type: "NOTHING_HEARD" })).toEqual(initialState);
    expect(reduce(listening, { type: "NOTHING_HEARD", error: "blocked" })).toMatchObject({ status: "error", error: "blocked" });
  });

  it("ignores events that do not belong to the current state", () => {
    expect(reduce(initialState, { type: "SPEECH_START" })).toBe(initialState);
    expect(reduce(initialState, { type: "ANSWER_DELTA", text: "late" })).toBe(initialState);
    expect(reduce(initialState, { type: "TRANSCRIPT", text: "late" })).toBe(initialState);
  });

  it("ends an answer that produced no speech", () => {
    const thinking = reduce(initialState, { type: "QUESTION", text: "q" });
    expect(reduce(thinking, { type: "SPEECH_END" }).status).toBe("idle");
  });

  it("returns to idle from any state on CLEAR, such as switching language mid-answer", () => {
    const speaking = run([{ type: "QUESTION", text: "q" }, { type: "ANSWER_DELTA", text: "a" }, { type: "SPEECH_START" }]);
    expect(speaking.status).toBe("speaking");
    expect(reduce(speaking, { type: "CLEAR" })).toEqual(initialState);
    expect(reduce({ ...initialState, status: "listening" }, { type: "CLEAR" })).toEqual(initialState);
  });

  it("recovers from errors with RESET", () => {
    const failed = run([{ type: "QUESTION", text: "q" }, { type: "FAIL", message: "oops" }]);
    expect(failed).toMatchObject({ status: "error", error: "oops" });
    expect(reduce(failed, { type: "RESET" })).toEqual(initialState);
  });
});
