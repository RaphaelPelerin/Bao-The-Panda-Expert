import { describe, expect, it } from "vitest";
import { readVerdict } from "../server/guard";

async function* chunks(...parts: string[]): AsyncGenerator<string> {
  for (const part of parts) yield part;
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const part of stream) text += part;
  return text;
}

describe("readVerdict", () => {
  it("passes the answer through after [IN]", async () => {
    const result = await readVerdict(chunks("[IN] Pandas eat ", "bamboo."));
    expect(result.verdict).toBe("in");
    expect(await collect(result.rest)).toBe("Pandas eat bamboo.");
  });

  it("handles a tag split across chunks and leading whitespace", async () => {
    const result = await readVerdict(chunks("\n [I", "N]", "  ", " Hello"));
    expect(result.verdict).toBe("in");
    expect(await collect(result.rest)).toBe("Hello");
  });

  it("drops everything after [OUT]", async () => {
    const result = await readVerdict(chunks("[OUT]", " Actually the weather is sunny."));
    expect(result.verdict).toBe("out");
    expect(await collect(result.rest)).toBe("");
  });

  it("fails closed when the tag is missing", async () => {
    const result = await readVerdict(chunks("Sure! The weather today is sunny."));
    expect(result.verdict).toBe("out");
    expect(await collect(result.rest)).toBe("");
  });

  it("fails closed on an empty stream", async () => {
    expect((await readVerdict(chunks())).verdict).toBe("out");
  });

  it("stops reading the model once it says [OUT]", async () => {
    let pulled = 0;
    async function* counting() {
      for (const part of ["[OUT]", "a", "b", "c"]) {
        pulled++;
        yield part;
      }
    }
    await readVerdict(counting());
    expect(pulled).toBe(1);
  });
});
