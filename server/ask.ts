import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MAX_HISTORY_TURNS,
  MAX_QUESTION_CHARS,
  type AskEvent,
  type AskRequest,
  type Lang,
  type Turn,
} from "../shared/protocol";
import { readVerdict, type GuardedStream } from "./guard";
import { REFUSALS } from "./prompt";
import { providerChain, type Provider } from "./providers";

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

const MAX_BODY_BYTES = 16_000;
const { mode: MODE, chain: PROVIDERS } = providerChain(process.env);
console.log(`[ask] providers (${MODE}): ${PROVIDERS.map((p) => p.name).join(" → ")}`);

// In auto mode, a provider with bad credentials or no network is skipped for
// the rest of the server's life instead of failing every request.
const disabled = new Set<Provider>();

export async function handleAsk(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
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

  // The client aborts its fetch when the user interrupts; stop generating right away.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  const started = performance.now();
  try {
    const { guarded, provider } = await openGuardedStream(body, abort.signal);
    send({ type: "verdict", inScope: guarded.verdict === "in", provider });
    const verdictMs = Math.round(performance.now() - started);

    if (guarded.verdict === "out") {
      send({ type: "delta", text: REFUSALS[body.lang] });
    } else {
      for await (const text of guarded.rest) send({ type: "delta", text });
    }
    send({ type: "done" });
    console.log(`[ask] ${provider} ${guarded.verdict} verdict=${verdictMs}ms total=${Math.round(performance.now() - started)}ms`);
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

/**
 * Opens the first provider in the chain that answers. Failures only happen
 * before the verdict (the first tokens), so falling through is invisible to the user.
 */
async function openGuardedStream(body: AskRequest, signal: AbortSignal): Promise<{ guarded: GuardedStream; provider: string }> {
  const candidates = PROVIDERS.filter((p) => !disabled.has(p));
  for (const [index, provider] of candidates.entries()) {
    const isLast = index === candidates.length - 1;
    try {
      return { guarded: await readVerdict(provider.stream(body, signal)), provider: provider.name };
    } catch (error) {
      const unavailable = provider.unavailability(error);
      if (MODE !== "auto" || isLast || !unavailable || signal.aborted) throw error;
      if (unavailable === "permanent") disabled.add(provider);
      console.warn(
        `[ask] ${provider.name} unavailable (${unavailable}), trying the next provider:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  throw new Error("No provider available");
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

  const safeLang: Lang = lang === "fr" ? "fr" : "en";
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

  // The API requires the conversation to start with a user turn.
  while (turns[0]?.role === "assistant") turns.shift();

  return { question: question.trim(), lang: safeLang, history: turns };
}
