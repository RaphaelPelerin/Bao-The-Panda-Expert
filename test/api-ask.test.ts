import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/ask.js";

const streamAsk = vi.hoisted(() => vi.fn());

vi.mock("../server/ask.js", () => ({
  parseRequest: (raw: string) => JSON.parse(raw),
  serverApiKey: () => "test-key",
  takeQuestion: async () => ({ allowed: true, usage: null }),
  currentUsage: async () => null,
  streamAsk,
}));

function fakeRequest(): VercelRequest {
  const req = Readable.from([Buffer.from(JSON.stringify({ question: "q", lang: "en", history: [] }))]);
  return Object.assign(req, { method: "POST" }) as unknown as VercelRequest;
}

function fakeResponse() {
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead: vi.fn(),
    write: vi.fn(),
    end() {
      this.writableEnded = true;
    },
  });
  return res as typeof res & VercelResponse;
}

/** Runs the handler until it calls streamAsk, and returns what it was given. */
async function startAnswer(req: VercelRequest, res: VercelResponse) {
  let finish = () => {};
  const answering = new Promise<void>((resolve) => (finish = resolve));
  const started = new Promise<AbortSignal>((resolve) => {
    streamAsk.mockImplementationOnce((_body: unknown, _key: string, signal: AbortSignal) => {
      resolve(signal);
      return answering;
    });
  });
  const done = handler(req, res);
  return { signal: await started, finish, done };
}

describe("api/ask", () => {
  beforeEach(() => streamAsk.mockReset());

  it("keeps answering when the request closes, which happens once its body is read", async () => {
    const req = fakeRequest();
    const { signal, finish, done } = await startAnswer(req, fakeResponse());
    req.emit("close");
    expect(signal.aborted).toBe(false);
    finish();
    await done;
  });

  it("stops generating when the client disconnects", async () => {
    const res = fakeResponse();
    const { signal, finish, done } = await startAnswer(fakeRequest(), res);
    res.emit("close");
    expect(signal.aborted).toBe(true);
    finish();
    await done;
  });
});
