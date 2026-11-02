import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readVerdict } from "../server/guard";
import { providerChain } from "../server/providers";
import {
  openAICompatibleUnavailability,
  resolveLlmConfig,
  streamOpenAICompatible,
  type LlmConfig,
} from "../server/providers/openaiCompatible";

// A tiny stand-in for DeepSeek/Qwen: streams chat-completion chunks, or fails on demand.
let server: Server;
let baseURL = "";
let lastBody: { model: string; messages: { role: string; content: string }[] } | null = null;

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
    if (auth === "Bearer broke") {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Insufficient Balance" } }));
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

const config = (apiKey: string): LlmConfig => ({ name: "mock", apiKey, baseURL, model: "mock-model" });
const request = { question: "What do pandas eat?", lang: "en" as const, history: [{ role: "user" as const, text: "Hi" }] };

describe("OpenAI-compatible provider", () => {
  it("streams through the topic guard", async () => {
    const { verdict, rest } = await readVerdict(streamOpenAICompatible(config("good"), request, new AbortController().signal));
    let text = "";
    for await (const part of rest) text += part;
    expect(verdict).toBe("in");
    expect(text).toBe("Bamboo, mostly bamboo!");
  });

  it("sends the system prompt, history and question", async () => {
    await readVerdict(streamOpenAICompatible(config("good"), request, new AbortController().signal));
    expect(lastBody?.model).toBe("mock-model");
    expect(lastBody?.messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(lastBody?.messages[0].content).toContain("[OUT]");
    expect(lastBody?.messages.at(-1)?.content).toBe("What do pandas eat?");
  });

  it("classifies bad keys as permanent and an empty balance as temporary", async () => {
    const failure = async (key: string) => {
      try {
        await readVerdict(streamOpenAICompatible(config(key), request, new AbortController().signal));
      } catch (error) {
        return openAICompatibleUnavailability(error);
      }
      return "no error";
    };
    expect(await failure("bad-key")).toBe("permanent");
    expect(await failure("broke")).toBe("temporary");
  });
});

describe("provider configuration", () => {
  it("is off without LLM_API_KEY", () => {
    expect(resolveLlmConfig({})).toBeNull();
  });

  it("defaults to the DeepSeek preset", () => {
    expect(resolveLlmConfig({ LLM_API_KEY: "k" })).toMatchObject({ name: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-chat" });
  });

  it("supports the Qwen presets and overrides", () => {
    expect(resolveLlmConfig({ LLM_API_KEY: "k", LLM_PROVIDER: "qwen" })?.baseURL).toContain("dashscope.aliyuncs.com");
    expect(resolveLlmConfig({ LLM_API_KEY: "k", LLM_PROVIDER: "qwen-intl", LLM_MODEL: "qwen-plus" })).toMatchObject({
      baseURL: expect.stringContaining("dashscope-intl"),
      model: "qwen-plus",
    });
  });

  it("requires a base URL and model for unknown providers", () => {
    expect(() => resolveLlmConfig({ LLM_API_KEY: "k", LLM_PROVIDER: "kimi" })).toThrow(/LLM_BASE_URL/);
    expect(resolveLlmConfig({ LLM_API_KEY: "k", LLM_PROVIDER: "kimi", LLM_BASE_URL: "https://api.moonshot.cn/v1", LLM_MODEL: "m" })?.name).toBe("kimi");
  });

  it("orders the auto chain: OpenAI-compatible, Claude, offline", () => {
    expect(providerChain({ LLM_API_KEY: "k" }).chain.map((p) => p.name)).toEqual(["deepseek", "claude", "offline"]);
    expect(providerChain({}).chain.map((p) => p.name)).toEqual(["claude", "offline"]);
    expect(providerChain({ PANDA_PROVIDER: "offline", LLM_API_KEY: "k" }).chain.map((p) => p.name)).toEqual(["offline"]);
  });
});
