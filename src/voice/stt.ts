import type { Lang } from "../../shared/protocol";
import { transcribeLocal, warmWhisper } from "./whisper";

// Chrome's Google recognizer is blocked in mainland China. The mic records here
// and Whisper tiny turns speech into text on the device — free, no speech API.

export type SttErrorKind = "denied" | "no-speech" | "unavailable" | "other";

export interface SttHandlers {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onNothing(error?: SttErrorKind): void;
}

const SPEECH_RMS = 0.02;
const MIN_SPEECH_MS = 300;
const SILENCE_MS = 900;
const MAX_MS = 20_000;

type AudioCtor = typeof AudioContext;

function audioCtor(): AudioCtor | undefined {
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext;
}

export const isSttSupported = (): boolean =>
  typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function" && audioCtor() !== undefined;

export class SpeechInput {
  private generation = 0;
  private session = 0;
  private lang: Lang = "en";
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private samples: Float32Array[] = [];
  private speechMs = 0;
  private quietMs = 0;
  private elapsedMs = 0;
  private finalizing = false;

  constructor(private readonly handlers: SttHandlers) {
    warmWhisper();
  }

  start(lang: Lang): void {
    this.abort();
    const Ctor = audioCtor();
    if (!Ctor || !navigator.mediaDevices?.getUserMedia) {
      this.handlers.onNothing("other");
      return;
    }
    this.lang = lang;
    this.session++;
    const generation = this.generation;
    const session = this.session;
    const context = new Ctor({ sampleRate: 16_000 });
    this.context = context;
    void context.resume();
    void this.capture(generation, session, context);
  }

  stop(): void {
    void this.finalize(this.generation, this.session);
  }

  abort(): void {
    this.generation++;
    this.session++;
    this.cleanup();
  }

  private async capture(generation: number, session: number, context: AudioContext): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      if (generation !== this.generation || session !== this.session) return;
      this.cleanup();
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
      this.handlers.onNothing(denied ? "denied" : "other");
      return;
    }
    if (generation !== this.generation || session !== this.session) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    this.stream = stream;
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const mute = context.createGain();
    mute.gain.value = 0;
    processor.onaudioprocess = (event) => {
      if (generation !== this.generation || session !== this.session || this.finalizing) return;
      const data = event.inputBuffer.getChannelData(0);
      this.samples.push(new Float32Array(data));
      let sum = 0;
      for (const sample of data) sum += sample * sample;
      const rms = Math.sqrt(sum / data.length);
      const ms = (data.length / context.sampleRate) * 1000;
      this.elapsedMs += ms;
      if (rms >= SPEECH_RMS) {
        this.speechMs += ms;
        this.quietMs = 0;
      } else if (this.speechMs > 0) {
        this.quietMs += ms;
      }
      if ((this.speechMs >= MIN_SPEECH_MS && this.quietMs >= SILENCE_MS) || this.elapsedMs >= MAX_MS) {
        void this.finalize(generation, session);
      }
    };
    source.connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);
    this.processor = processor;
  }

  private async finalize(generation: number, session: number): Promise<void> {
    if (generation !== this.generation || session !== this.session || this.finalizing) return;
    this.finalizing = true;
    this.session++;
    const samples = this.samples;
    const sampleRate = this.context?.sampleRate ?? 16_000;
    const heard = this.speechMs >= MIN_SPEECH_MS;
    const lang = this.lang;
    this.cleanup();
    if (generation !== this.generation) return;
    if (!heard) {
      this.handlers.onNothing("no-speech");
      return;
    }

    try {
      this.handlers.onInterim("…");
      const text = await transcribeLocal(samples, sampleRate, lang);
      if (generation !== this.generation) return;
      if (text) this.handlers.onFinal(text);
      else this.handlers.onNothing("no-speech");
    } catch (error) {
      if (generation !== this.generation) return;
      console.error(error);
      this.handlers.onNothing("unavailable");
    }
  }

  private cleanup(): void {
    this.finalizing = false;
    this.samples = [];
    this.speechMs = 0;
    this.quietMs = 0;
    this.elapsedMs = 0;
    this.processor?.disconnect();
    this.processor = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    void this.context?.close();
    this.context = null;
  }
}
