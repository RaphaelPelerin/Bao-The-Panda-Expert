import type { Lang } from "../../shared/protocol";
import { prepareAudio } from "./wav";

// Free on-device speech-to-text. Whisper tiny runs entirely in the browser —
// no server proxy. Weights load from a public host (hf-mirror first for China,
// then huggingface.co) and are cached by the browser.

type Transcriber = (
  audio: Float32Array,
  options?: { language?: string; task?: string },
) => Promise<{ text?: string } | string>;

const WHISPER_LANG: Record<Lang, string> = { en: "english", fr: "french", zh: "chinese" };
const REMOTE_HOSTS = ["https://hf-mirror.com", "https://huggingface.co"] as const;

let loading: Promise<Transcriber> | null = null;
let transcriber: Transcriber | null = null;

export function warmWhisper(): void {
  void getTranscriber().catch((error) => {
    console.warn("[whisper] warm-up failed", error);
  });
}

export async function transcribeLocal(chunks: Float32Array[], sampleRate: number, lang: Lang): Promise<string> {
  const run = await getTranscriber();
  const audio = prepareAudio(chunks, sampleRate);
  if (!audio.length) return "";
  const result = await run(audio, { language: WHISPER_LANG[lang], task: "transcribe" });
  return (typeof result === "string" ? result : result.text ?? "").trim();
}

async function getTranscriber(): Promise<Transcriber> {
  if (transcriber) return transcriber;
  if (!loading) loading = loadTranscriber();
  try {
    transcriber = await loading;
    return transcriber;
  } catch (error) {
    loading = null;
    throw error;
  }
}

async function loadTranscriber(): Promise<Transcriber> {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.remotePathTemplate = "{model}/resolve/{revision}/";

  let lastError: unknown;
  for (const host of REMOTE_HOSTS) {
    try {
      env.remoteHost = host;
      const pipe = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny", {
        dtype: "q8",
        device: "wasm",
      });
      return pipe as unknown as Transcriber;
    } catch (error) {
      lastError = error;
      console.warn(`[whisper] load via ${host} failed`, error);
    }
  }

  // Last resort: library defaults (huggingface.co).
  try {
    env.remoteHost = "https://huggingface.co";
    const pipe = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny");
    return pipe as unknown as Transcriber;
  } catch (error) {
    throw lastError ?? error;
  }
}
