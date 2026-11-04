import type { IncomingMessage, ServerResponse } from "node:http";
import { isLang, type Lang, type QwenRegion } from "../shared/protocol.js";
import { serverApiKey, serverRegion } from "./ask.js";

// Bao's voice: Alibaba's Qwen-Audio text-to-speech, with the same key as the answers.
// Picked for the lowest delay we measured (about 0.4 s to first audio) and a very low
// cost (about $0.0001 for two sentences). The audio streams to the browser as it arrives.

export const TTS_MODEL = "qwen-audio-3.1-tts-flash";
/** The male voice that speaks every language here, available in both regions. */
export const TTS_VOICE = "xunanchuan_v3.1";
/** 16-bit mono PCM. The browser plays it at this exact rate. */
export const TTS_SAMPLE_RATE = 24_000;
/** A little higher than natural, for a young, cuddly character. */
const PANDA_PITCH = 1.12;
/** The API requires the instruction to be in the language of the text. */
const PANDA_STYLE: Record<Lang, string> = {
  en: "Speak like a friendly, cuddly, playful cartoon panda: warm, gentle and a little goofy.",
  fr: "Parle comme un gentil panda de dessin animé : chaleureux, doux et un peu rigolo.",
  zh: "像一只可爱友好的卡通大熊猫那样说话：温暖、温柔，带点憨厚和俏皮。",
};

/** One sentence at a time. Caps what a single request can cost. */
export const MAX_TTS_CHARS = 400;
const MAX_BODY_BYTES = 4_000;

const HOSTS: Record<QwenRegion, string> = {
  "qwen-intl": "https://dashscope-intl.aliyuncs.com",
  qwen: "https://dashscope.aliyuncs.com",
};

export function parseTtsRequest(raw: string): { text: string; lang: Lang } {
  const data: unknown = JSON.parse(raw);
  if (typeof data !== "object" || data === null) throw new Error("Expected a JSON object");
  const { text, lang } = data as Record<string, unknown>;
  if (typeof text !== "string" || !text.trim()) throw new Error("Missing text");
  if (text.length > MAX_TTS_CHARS) throw new Error("Text too long");
  return { text: text.trim(), lang: isLang(lang) ? lang : "en" };
}

export function speechBody(text: string, lang: Lang) {
  return {
    model: TTS_MODEL,
    input: {
      text,
      voice: TTS_VOICE,
      format: "pcm",
      sample_rate: TTS_SAMPLE_RATE,
      pitch: PANDA_PITCH,
      language_hints: [lang],
      instruction: PANDA_STYLE[lang],
    },
  };
}

/** Audio bytes from one line of the provider's event stream, or nothing. Throws on a reported error. */
export function audioFromEventLine(line: string): Buffer | null {
  if (!line.startsWith("data:")) return null;
  const event = JSON.parse(line.slice(5)) as { code?: string; message?: string; output?: { audio?: { data?: string } } };
  if (event.code) throw new Error(`${event.code}: ${event.message}`);
  const data = event.output?.audio?.data;
  return data ? Buffer.from(data, "base64") : null;
}

/** Yields raw PCM as Alibaba produces it. */
export async function* streamSpeech(
  apiKey: string,
  region: QwenRegion,
  text: string,
  lang: Lang,
  signal: AbortSignal,
): AsyncGenerator<Buffer> {
  const response = await fetch(`${HOSTS[region]}/api/v1/services/audio/tts/SpeechSynthesizer`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-DashScope-SSE": "enable" },
    body: JSON.stringify(speechBody(text, lang)),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`Speech service answered ${response.status}`);

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const part of response.body) {
    buffer += decoder.decode(part, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const audio = audioFromEventLine(buffer.slice(0, end).trim());
      buffer = buffer.slice(end + 1);
      if (audio) yield audio;
    }
  }
}

/** POST { text, lang } → a stream of PCM. The key stays on the server. */
export async function handleTts(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  const apiKey = serverApiKey();
  if (!apiKey) {
    res.writeHead(503).end();
    return;
  }

  let body: { text: string; lang: Lang };
  try {
    body = parseTtsRequest(await readBody(req));
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Bad request" }));
    return;
  }

  // Stop paying for audio nobody will hear when the user interrupts.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  let started = false;
  try {
    for await (const audio of streamSpeech(apiKey, serverRegion(), body.text, body.lang, abort.signal)) {
      if (!started) {
        started = true;
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      }
      res.write(audio);
    }
    if (!started) res.writeHead(502);
  } catch (error) {
    if (!abort.signal.aborted) {
      console.error("[tts] failed:", error);
      // Before any audio, a status lets the browser fall back to a local voice.
      if (!started) res.writeHead(502);
    }
  } finally {
    res.end();
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
