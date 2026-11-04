import type { Lang } from "../../shared/protocol";
import { loading } from "../loading";
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

let starting: Promise<Transcriber> | null = null;
let transcriber: Transcriber | null = null;

export function warmWhisper(): void {
  const load = getTranscriber();
  loading.track("whisper", load);
  void load.catch((error) => {
    console.warn("[whisper] warm-up failed", error);
  });
}

/** The model still has to start after its last byte arrives, so downloading stops short of full. */
function onProgress(info: { status: string; progress?: number }): void {
  if (info.status === "progress_total" && info.progress !== undefined) loading.report("whisper", (info.progress / 100) * 0.9);
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
  if (!starting) starting = loadTranscriber();
  try {
    transcriber = await starting;
    return transcriber;
  } catch (error) {
    starting = null;
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
        progress_callback: onProgress,
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
    const pipe = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny", { progress_callback: onProgress });
    return pipe as unknown as Transcriber;
  } catch (error) {
    throw lastError ?? error;
  }
}
