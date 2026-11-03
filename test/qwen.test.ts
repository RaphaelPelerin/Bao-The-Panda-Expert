import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readVerdict } from "../server/guard";
import { providerChain } from "../server/providers";
import { qwenUnavailability, resolveQwenConfig, streamQwen, type QwenConfig } from "../server/providers/qwen";

// A tiny stand-in for Qwen's OpenAI-compatible endpoint: streams chat-completion chunks, or fails on demand.
let server: Server;
let baseURL = "";
let lastBody: { model: string; messages: { role: string; content: string }[]; enable_thinking?: boolean } | null = null;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    lastBody = JSON.parse(raw);
    const auth = req.headers.authorization;

    if (auth === "Bearer bad-key") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Authentication Fails" } }));
      return;
    }
    if (auth === "Bearer not-activated") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Access to model denied.", code: "AccessDenied.Unpurchased" } }));
      return;
    }
    if (auth === "Bearer free-tier-done") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Free quota exhausted.", code: "AllocationQuota.FreeTierOnly" } }));
      return;
    }
    if (auth === "Bearer broke") {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Free quota exhausted" } }));
      return;
    }

    const parts = ["[IN", "] Bamboo, ", "mostly bamboo!"];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const content of parts) {
      const chunk = { id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content }, finish_reason: null }] };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => {
  server.close();
});

const config = (apiKey: string): QwenConfig => ({ name: "mock", apiKey, baseURL, model: "qwen-flash", extraBody: { enable_thinking: false } });
const request = { question: "What do pandas eat?", lang: "en" as const, history: [{ role: "user" as const, text: "Hi" }] };

describe("Qwen provider", () => {
  it("streams through the topic guard", async () => {
    const { verdict, rest } = await readVerdict(streamQwen(config("good"), request, new AbortController().signal));
    let text = "";
    for await (const part of rest) text += part;
    expect(verdict).toBe("in");
    expect(text).toBe("Bamboo, mostly bamboo!");
  });

  it("sends the system prompt, history and question, with thinking off", async () => {
    await readVerdict(streamQwen(config("good"), request, new AbortController().signal));
    expect(lastBody?.model).toBe("qwen-flash");
    expect(lastBody?.messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(lastBody?.messages[0].content).toContain("[OUT]");
    expect(lastBody?.messages.at(-1)?.content).toBe("What do pandas eat?");
    expect(lastBody?.enable_thinking).toBe(false);
  });

  it("classifies bad keys as permanent and an exhausted quota as temporary", async () => {
    const failure = async (key: string) => {
      try {
        await readVerdict(streamQwen(config(key), request, new AbortController().signal));
      } catch (error) {
        return qwenUnavailability(error);
      }
      return "no error";
    };
    expect(await failure("bad-key")).toBe("permanent");
    expect(await failure("not-activated")).toBe("permanent");
    expect(await failure("free-tier-done")).toBe("permanent");
    expect(await failure("broke")).toBe("temporary");
  });
});

describe("provider configuration", () => {
  it("is off without LLM_API_KEY, even with the video generation's OpenRouter key", () => {
    expect(resolveQwenConfig({})).toBeNull();
    expect(resolveQwenConfig({ OPENROUTER_API_KEY: "o" })).toBeNull();
  });

  it("uses Qwen Flash on the international endpoint, without thinking", () => {
    expect(resolveQwenConfig({ LLM_API_KEY: "k" })).toMatchObject({
      name: "qwen-intl",
      baseURL: expect.stringContaining("dashscope-intl.aliyuncs.com"),
      model: "qwen-flash-character",
      extraBody: { enable_thinking: false },
    });
  });

  it("supports the mainland China region and rejects anything else", () => {
    expect(resolveQwenConfig({ LLM_API_KEY: "k", LLM_PROVIDER: "qwen" })?.baseURL).toContain("//dashscope.aliyuncs.com");
    expect(() => resolveQwenConfig({ LLM_API_KEY: "k", LLM_PROVIDER: "deepseek" })).toThrow(/LLM_PROVIDER/);
  });

  it("falls back to offline in auto mode", () => {
    expect(providerChain({ LLM_API_KEY: "k" }).chain.map((p) => p.name)).toEqual(["qwen-intl", "offline"]);
    expect(providerChain({}).chain.map((p) => p.name)).toEqual(["offline"]);
    expect(providerChain({ PANDA_PROVIDER: "offline", LLM_API_KEY: "k" }).chain.map((p) => p.name)).toEqual(["offline"]);
    expect(providerChain({ PANDA_PROVIDER: "qwen", LLM_API_KEY: "k" }).chain.map((p) => p.name)).toEqual(["qwen-intl"]);
  });
});
