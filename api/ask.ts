import type { VercelRequest, VercelResponse } from "@vercel/node";
import { parseRequest, serverApiKey, streamAsk } from "../server/ask.js";
import type { AskEvent } from "../shared/protocol.js";

export const config = {
  api: {
    bodyParser: false,
  },
  // Hobby default is short; keep room for a streamed Qwen reply.
  maxDuration: 60,
};

/** Vercel serverless: key from LLM_API_KEY env (never from the browser). */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).setHeader("Allow", "POST").end();
    return;
  }

  const apiKey = serverApiKey();
  if (!apiKey) {
    res.status(503).json({ error: "Server is missing LLM_API_KEY." });
    return;
  }

  let body;
  try {
    body = parseRequest(await readRawBody(req));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Bad request" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: AskEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const abort = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  try {
    await streamAsk(body, apiKey, abort.signal, send);
  } catch (error) {
    if (!abort.signal.aborted) {
      console.error("[ask] failed:", error);
      send({ type: "error", message: "The panda lost its train of thought. Please try again." });
    }
  } finally {
    res.end();
  }
}

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 16_000) throw new Error("Request too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}
