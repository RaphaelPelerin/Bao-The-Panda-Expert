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
import { isClaudeUnavailable, streamClaude } from "./providers/claude";
import { streamOffline } from "./providers/offline";

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

type ProviderMode = "auto" | "claude" | "offline";
const MODE: ProviderMode = (["auto", "claude", "offline"] as const).find((m) => m === process.env.PANDA_PROVIDER) ?? "auto";
const MAX_BODY_BYTES = 16_000;

// In auto mode, the first credential or network failure switches the server to
// offline answers for the rest of its life instead of failing every request.
let claudeDisabled = MODE === "offline";

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

async function openGuardedStream(
  body: AskRequest,
  signal: AbortSignal,
): Promise<{ guarded: GuardedStream; provider: "claude" | "offline" }> {
  if (!claudeDisabled) {
    try {
      return { guarded: await readVerdict(streamClaude(body, signal)), provider: "claude" };
    } catch (error) {
      if (MODE !== "auto" || !isClaudeUnavailable(error)) throw error;
      claudeDisabled = true;
      console.warn("[ask] Claude unavailable, switching to offline answers:", error instanceof Error ? error.message : error);
    }
  }
  return { guarded: await readVerdict(streamOffline(body, signal)), provider: "offline" };
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
