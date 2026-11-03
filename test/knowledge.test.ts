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

  it("answers in Mandarin", () => {
    const result = answerOffline("熊猫吃什么？", "zh", []);
    expect(result.inScope).toBe(true);
    expect(result.text).toContain("竹子");
    expect(answerOffline("大熊猫住在哪里？", "zh", []).text).toContain("四川");
    expect(answerOffline("熊猫为什么是黑白的？", "zh", []).text).toContain("黑白");
    expect(answerOffline("熊猫濒危吗？", "zh", []).text).toContain("易危");
    expect(answerOffline("今天天气怎么样？", "zh", []).inScope).toBe(false);
    expect(answerOffline("怎么用 Python 写熊猫的代码？", "zh", []).inScope).toBe(false);
  });

  it("accepts a Mandarin follow-up that refers to an earlier panda answer", () => {
    const history = [
      { role: "user" as const, text: "熊猫吃什么？" },
      { role: "assistant" as const, text: "竹子，竹子，还是竹子！" },
    ];
    const result = answerOffline("它们能活多久？", "zh", history);
    expect(result.inScope).toBe(true);
    expect(result.text).toContain("十五");
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
