import type { Lang } from "../../shared/protocol";
import type { PiperRequest, PiperResponse } from "./piper.worker";
import { PIPER_VOICES, type PiperState } from "./voiceStatus";

/** Main-thread client of the Piper worker. Started on demand, so tests and idle pages cost nothing. */
export class PiperVoice {
  private worker: Worker | null = null;
  private wanted: string | null = null;
  private ready: string | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve(wav: ArrayBuffer): void; reject(error: Error): void }>();

  constructor(private readonly onState: (state: PiperState) => void) {}

  /** Starts downloading the voice for a language, unless it is already there. */
  preload(lang: Lang): void {
    const voiceId = PIPER_VOICES[lang];
    if (this.wanted === voiceId) return;
    this.wanted = voiceId;
    this.ready = null;
    this.onState({ state: "loading", percent: 0 });
    try {
      this.send({ type: "load", voiceId });
    } catch (error) {
      console.warn("[piper] could not start", error);
      this.onState({ state: "failed" });
    }
  }

  isReady(lang: Lang): boolean {
    return this.ready === PIPER_VOICES[lang];
  }

  /** Renders one sentence to WAV bytes. Rejects if the voice fails, so the caller can fall back. */
  synthesize(text: string): Promise<ArrayBuffer> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: "speak", id, text });
    });
  }

  private send(message: PiperRequest): void {
    if (!this.worker) {
      this.worker = new Worker(new URL("./piper.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = ({ data }: MessageEvent<PiperResponse>) => this.receive(data);
      this.worker.onerror = (event) => this.crash(event.message);
    }
    this.worker.postMessage(message);
  }

  private receive(message: PiperResponse): void {
    switch (message.type) {
      case "progress":
        if (message.voiceId === this.wanted) this.onState({ state: "loading", percent: message.percent });
        break;
      case "ready":
        if (message.voiceId === this.wanted) {
          this.ready = message.voiceId;
          this.onState({ state: "ready" });
        }
        break;
      case "failed":
        console.warn("[piper] voice unavailable:", message.message);
        if (message.voiceId === this.wanted) this.onState({ state: "failed" });
        break;
      case "audio":
        this.pending.get(message.id)?.resolve(message.wav);
        this.pending.delete(message.id);
        break;
      case "error":
        this.pending.get(message.id)?.reject(new Error(message.message));
        this.pending.delete(message.id);
        break;
    }
  }

  private crash(reason: string): void {
    console.warn("[piper] worker crashed:", reason);
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.wanted = null;
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
    this.onState({ state: "failed" });
  }
}
