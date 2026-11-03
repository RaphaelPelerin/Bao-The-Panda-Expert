import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MAX_HISTORY_TURNS,
  MAX_QUESTION_CHARS,
  isLang,
  isQwenRegion,
  type AskEvent,
  type AskRequest,
  type QwenRegion,
  type Turn,
} from "../shared/protocol";
import { readVerdict } from "./guard";
import { REFUSALS } from "./prompt";
import { makeQwenProvider } from "./providers";

try {
  process.loadEnvFile();
} catch {
  // No .env: use the real environment (Vercel dashboard vars).
}

const MAX_BODY_BYTES = 16_000;

export async function handleAsk(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }

  const apiKey = serverApiKey();
  if (!apiKey) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Server is missing LLM_API_KEY." }));
    return;
  }

  let body: AskRequest;
  try {
    body = parseRequest(await readBody(req));
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Bad request" }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: AskEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  const started = performance.now();
  try {
    await streamAsk(body, apiKey, abort.signal, send);
    console.log(`[ask] total=${Math.round(performance.now() - started)}ms`);
  } catch (error) {
    if (abort.signal.aborted) {
      console.log("[ask] aborted by client");
    } else {
      console.error("[ask] failed:", error);
      send({ type: "error", message: "The panda lost its train of thought. Please try again." });
    }
  } finally {
    res.end();
  }
}

/** Streams ask events. Model is always qwen-flash-character; key/region from server env. */
export async function streamAsk(
  body: AskRequest,
  apiKey: string,
  signal: AbortSignal,
  send: (event: AskEvent) => void,
): Promise<void> {
  const region = serverRegion();
  const provider = makeQwenProvider(apiKey, region);
  const started = performance.now();
  const guarded = await readVerdict(provider.stream(body, signal));
  send({ type: "verdict", inScope: guarded.verdict === "in", provider: provider.name });
  const verdictMs = Math.round(performance.now() - started);

  if (guarded.verdict === "out") {
    send({ type: "delta", text: REFUSALS[body.lang] });
  } else {
    for await (const text of guarded.rest) send({ type: "delta", text });
  }
  send({ type: "done" });
  console.log(`[ask] ${provider.name} ${guarded.verdict} verdict=${verdictMs}ms`);
}

export function serverApiKey(): string | null {
  const key = process.env.LLM_API_KEY?.trim();
  return key || null;
}

export function serverRegion(): QwenRegion {
  const raw = process.env.LLM_PROVIDER?.trim();
  return isQwenRegion(raw) ? raw : "qwen-intl";
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseRequest(raw: string): AskRequest {
  const data: unknown = JSON.parse(raw);
  if (typeof data !== "object" || data === null) throw new Error("Expected a JSON object");
  const { question, lang, history } = data as Record<string, unknown>;

  if (typeof question !== "string" || !question.trim()) throw new Error("Missing question");
  if (question.length > MAX_QUESTION_CHARS) throw new Error("Question too long");

  const safeLang = isLang(lang) ? lang : "en";
  const turns: Turn[] = Array.isArray(history)
    ? history
        .filter(
          (t): t is Turn =>
            typeof t === "object" &&
            t !== null &&
            (t.role === "user" || t.role === "assistant") &&
            typeof t.text === "string" &&
            t.text.trim().length > 0,
        )
        .slice(-MAX_HISTORY_TURNS)
        .map((t) => ({ role: t.role, text: t.text.slice(0, 1000) }))
    : [];

  while (turns[0]?.role === "assistant") turns.shift();

  return {
    question: question.trim(),
    lang: safeLang,
    history: turns,
  };
}
