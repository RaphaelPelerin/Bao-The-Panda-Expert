import { describe, expect, it } from "vitest";
import { SentenceChunker } from "../src/llm/sentences";

function feed(parts: string[]): string[] {
  const chunker = new SentenceChunker();
  return [...parts.flatMap((p) => chunker.push(p)), ...chunker.flush()];
}

describe("SentenceChunker", () => {
  it("emits each sentence as soon as it is complete", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("Pandas eat bam")).toEqual([]);
    expect(chunker.push("boo. They also ")).toEqual(["Pandas eat bamboo."]);
    expect(chunker.push("nap a lot! Really?")).toEqual(["They also nap a lot!"]);
    expect(chunker.flush()).toEqual(["Really?"]);
  });

  it("does not split decimal numbers", () => {
    expect(feed(["They weigh about 1.5 times more. Wow."])).toEqual(["They weigh about 1.5 times more.", "Wow."]);
  });

  it("cuts very long sentences at a comma so speech can start early", () => {
    const long = "A grown panda spends most of the day eating bamboo in the misty mountain forests of central China, then naps for a few hours, then eats again and again until night falls";
    const [first] = new SentenceChunker().push(long);
    expect(first.endsWith(",")).toBe(true);
  });

  it("returns nothing for whitespace", () => {
    expect(feed(["   ", "\n"])).toEqual([]);
  });
});
