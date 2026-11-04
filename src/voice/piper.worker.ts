import { TtsSession } from "@mintplex-labs/piper-tts-web";
import piperData from "@diffusionstudio/piper-wasm/build/piper_phonemize.data?url";
import piperWasm from "@diffusionstudio/piper-wasm/build/piper_phonemize.wasm?url";
import onnxWasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";

// Free neural text-to-speech that runs on the visitor's device. It lives in a
// worker so synthesis can never freeze the 3D scene. The runtime files ship with
// the site; only the voices are downloaded, then cached in the browser.

export type PiperRequest =
  | { type: "load"; voiceId: string }
  | { type: "speak"; id: number; text: string };

export type PiperResponse =
  | { type: "progress"; voiceId: string; percent: number }
  | { type: "ready"; voiceId: string }
  | { type: "failed"; voiceId: string; message: string }
  | { type: "audio"; id: number; wav: ArrayBuffer }
  | { type: "error"; id: number; message: string };

const VOICES_PATH = "/diffusionstudio/piper-voices/resolve/main";
const OFFICIAL_HOST = "https://huggingface.co";
/** The mirror comes first: huggingface.co is not reachable from mainland China. */
const VOICE_HOSTS = ["https://hf-mirror.com", OFFICIAL_HOST];

// The library has the voice URL hard-coded and caches whatever it receives, even
// an error page. So try each host in turn, and only hand over a successful answer.
const nativeFetch = self.fetch.bind(self);
self.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith(OFFICIAL_HOST + VOICES_PATH)) return nativeFetch(input, init);

  let lastError: unknown;
  for (const host of VOICE_HOSTS) {
    try {
      const response = await nativeFetch(url.replace(OFFICIAL_HOST, host), init);
      if (response.ok) return response;
      lastError = new Error(`${host} answered ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

const post = (message: PiperResponse, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: PiperResponse, t: Transferable[]): void }).postMessage(message, transfer);

let session: TtsSession | null = null;
/** One job at a time: sentences come out in order, and a load waits for the sentence in progress. */
let jobs: Promise<void> = Promise.resolve();

async function load(voiceId: string): Promise<void> {
  try {
    // The library keeps a single session; clear it so a new language really loads.
    TtsSession._instance = null;
    session = await TtsSession.create({
      voiceId: voiceId as ConstructorParameters<typeof TtsSession>[0]["voiceId"],
      progress: ({ url, loaded, total }) => {
        if (url.endsWith(".onnx") && total > 0) post({ type: "progress", voiceId, percent: Math.round((loaded / total) * 100) });
      },
      wasmPaths: {
        // ONNX Runtime accepts a map of file URLs; the library's type only mentions a folder.
        onnxWasm: { wasm: onnxWasm } as unknown as string,
        piperData,
        piperWasm,
      },
    });
    post({ type: "ready", voiceId });
  } catch (error) {
    session = null;
    post({ type: "failed", voiceId, message: error instanceof Error ? error.message : String(error) });
  }
}

async function speak(id: number, text: string): Promise<void> {
  try {
    if (!session) throw new Error("No voice loaded");
    // The library runs its phonemizer inside `new Promise(async ...)`, so an error
    // there is an unhandled rejection and its promise never settles. Catch that,
    // or one bad sentence would hang the queue, and the panda, forever.
    const predicted = session.predict(text);
    const crashed = new Promise<never>((_, reject) => {
      failCurrentJob = reject;
    });
    const wav = await (await Promise.race([predicted, crashed])).arrayBuffer();
    post({ type: "audio", id, wav }, [wav]);
  } catch (error) {
    post({ type: "error", id, message: error instanceof Error ? error.message : String(error) });
  } finally {
    failCurrentJob = null;
  }
}

let failCurrentJob: ((reason: unknown) => void) | null = null;
self.addEventListener("unhandledrejection", (event) => {
  failCurrentJob?.(event.reason);
});

self.onmessage = ({ data }: MessageEvent<PiperRequest>) => {
  jobs = jobs.then(() => (data.type === "load" ? load(data.voiceId) : speak(data.id, data.text)));
};
