import { describe, expect, it } from "vitest";
import { REFUSALS } from "../server/prompt";
import { answerOffline } from "../server/providers/knowledge";

describe("offline panda expert", () => {
  it.each([
    ["What do pandas eat?", "Bamboo"],
    ["Where do giant pandas live?", "China"],
    ["How long do pandas live?", "fifteen to twenty years"],
    ["Why are pandas black and white?", "camouflage"],
    ["Are pandas endangered?", "vulnerable"],
    ["How much bamboo does a panda eat every day?", "thirty-eight kilos"],
  ])("answers the challenge question %j", (question, expected) => {
    const result = answerOffline(question, "en", []);
    expect(result.inScope).toBe(true);
    expect(result.text).toContain(expected);
  });

  it.each([
    "What's the weather today?",
    "Can you help me write Python code?",
    "Who won the football match?",
    "How do I filter a pandas dataframe in Python?",
  ])("refuses %j", (question) => {
    expect(answerOffline(question, "en", []).inScope).toBe(false);
  });

  it("answers in French", () => {
    const result = answerOffline("Que mangent les pandas ?", "fr", []);
    expect(result.inScope).toBe(true);
    expect(result.text).toContain("bambou");
    expect(answerOffline("Où vivent les pandas géants ?", "fr", []).text).toContain("Chine");
    expect(answerOffline("Quel temps fait-il aujourd'hui ?", "fr", []).inScope).toBe(false);
  });

  it("accepts a follow-up that refers to an earlier panda answer", () => {
    const history = [
      { role: "user" as const, text: "What do pandas eat?" },
      { role: "assistant" as const, text: "Bamboo, bamboo and more bamboo!" },
    ];
    expect(answerOffline("And how long do they live?", "en", history).inScope).toBe(true);
  });

  it("does not treat a follow-up to a refusal as panda talk", () => {
    const history = [
      { role: "user" as const, text: "What's the weather?" },
      { role: "assistant" as const, text: REFUSALS.en },
    ];
    expect(answerOffline("And how long does it last?", "en", history).inScope).toBe(false);
  });

  it("gives a generic panda answer to an unknown panda question", () => {
    const result = answerOffline("Do pandas like music?", "en", []);
    expect(result.inScope).toBe(true);
    expect(result.text).toMatch(/panda/i);
  });
});
