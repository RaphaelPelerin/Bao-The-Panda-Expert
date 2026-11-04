import type { Lang } from "../../shared/protocol";
import { lipSync } from "../avatar/lipsync";
import { signals } from "../avatar/signals";
import { decodePcm, isMaleVoiceName } from "./voiceStatus";

export interface TtsHandlers {
  /** First sentence of an answer became audible. */
  onStart(): void;
  /** Every queued sentence finished and the answer is complete. */
  onDone(): void;
  /** Answers are silent: the speech service failed and this device has no usable voice. */
  onNoVoice(): void;
}

interface QueuedSentence {
  text: string;
  /** Requested as soon as the sentence arrives, so the next one is ready when the current one ends. */
  response: Promise<Response | null>;
}

/** Matches what /api/tts streams. Playing at the source rate avoids clicks between chunks. */
const SPEECH_SAMPLE_RATE = 24_000;
/** Small lead so the first chunk is never scheduled in the past. */
const START_DELAY_S = 0.02;
/** How long to wait for a suspended AudioContext before using another voice. */
const AUDIO_RESUME_TIMEOUT_MS = 500;

const LOCALES: Record<Lang, string> = { en: "en-US", fr: "fr-FR", zh: "zh-CN" };
/** Prefer voices that ship with the OS. */
const LOCAL_HINT = /local|desktop|offline|microsoft|apple|siri|samantha|ting-ting|mei-jia|sin-ji|xiaoxiao|xiaoyi|yunxia|yunyang|huihui|kangkang|hanhan|yaoyao/i;

/** Google and "Online" cloud voices are never used. */
export function isCloudVoice(voice: { name: string; voiceURI?: string }): boolean {
  return /google|\bonline\b/i.test(`${voice.name} ${voice.voiceURI ?? ""}`);
}

/**
 * Sentence queue. Each sentence streams from /api/tts (Alibaba, male panda voice)
 * and plays as it arrives. If that fails, it uses the browser's local voice, then
 * a silent timer so the conversation still moves.
 */
export class SpeechOutput {
  private queue: QueuedSentence[] = [];
  private finished = false;
  private active = false;
  private started = false;
  private generation = 0;
  private lang: Lang = "en";
  private voice: SpeechSynthesisVoice | null = null;
  // Chrome can garbage-collect a playing utterance and drop its events; keep a reference.
  private current: SpeechSynthesisUtterance | null = null;
  private readonly synth = typeof speechSynthesis === "undefined" ? null : speechSynthesis;
  private audioContext: AudioContext | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private requests = new AbortController();

  constructor(private readonly handlers: TtsHandlers) {
    this.synth?.addEventListener("voiceschanged", () => this.pickVoice());
    this.pickVoice();
  }

  setLang(lang: Lang): void {
    this.lang = lang;
    this.pickVoice();
  }

  enqueue(sentence: string): void {
    const text = sentence.trim();
    if (!text) return;
    const response = fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang: this.lang }),
      signal: this.requests.signal,
    }).catch(() => null);
    this.queue.push({ text, response });
    this.pump();
  }

  /** No more sentences are coming for this answer. */
  finish(): void {
    this.finished = true;
    this.pump();
  }

  /** Start a new answer, dropping anything still queued or playing. */
  reset(): void {
    this.generation++;
    this.queue = [];
    this.finished = false;
    this.active = false;
    this.started = false;
    this.requests.abort();
    this.requests = new AbortController();
    if (this.current) this.current.onend = this.current.onerror = null;
    this.current = null;
    this.synth?.cancel();
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
    }
    this.sources = [];
    signals.speaking = false;
    lipSync.stop();
  }

  private pump(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (next === undefined) {
      if (this.finished) {
        this.started = false;
        this.finished = false;
        signals.speaking = false;
        lipSync.stop();
        this.handlers.onDone();
      }
      return;
    }

    this.active = true;
    const generation = this.generation;
    const done = () => {
      if (generation !== this.generation) return;
      this.active = false;
      this.current = null;
      this.sources = [];
      this.pump();
    };
    void this.playStream(next, generation, done);
  }

  /** Plays one sentence as its audio arrives, or falls back if none does. */
  private async playStream(sentence: QueuedSentence, generation: number, done: () => void): Promise<void> {
    const isStale = () => generation !== this.generation;
    let playing = false;
    try {
      const response = await sentence.response;
      if (isStale()) return;
      if (!response?.ok || !response.body) throw new Error(`Speech service answered ${response?.status ?? "nothing"}`);

      const context = await this.runningAudioContext();
      if (isStale()) return;

      const reader = response.body.getReader();
      let leftover: Uint8Array = new Uint8Array(0);
      let startAt = 0;
      let endAt = 0;
      let last: AudioBufferSourceNode | null = null;
      while (true) {
        const { value, done: ended } = await reader.read();
        if (isStale()) return void reader.cancel().catch(() => {});
        if (ended) break;

        const bytes = new Uint8Array(leftover.length + value.length);
        bytes.set(leftover);
        bytes.set(value, leftover.length);
        const decoded = decodePcm(bytes);
        leftover = decoded.leftover;
        if (!decoded.samples.length) continue;

        const buffer = context.createBuffer(1, decoded.samples.length, SPEECH_SAMPLE_RATE);
        buffer.copyToChannel(new Float32Array(decoded.samples), 0);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);

        if (!playing) {
          playing = true;
          startAt = endAt = context.currentTime + START_DELAY_S;
          this.markStarted();
          lipSync.start(sentence.text, this.lang);
        }
        source.start(endAt);
        endAt += buffer.duration;
        this.sources.push(source);
        last = source;
      }
      if (!last) throw new Error("The speech stream was empty");

      // The whole sentence has arrived, usually long before it ends: the mouth can match its exact length.
      lipSync.stretchTo((endAt - startAt) * 1000);
      last.onended = () => {
        if (!isStale()) lipSync.stop();
        done();
      };
    } catch (error) {
      if (isStale()) return;
      console.warn("[tts] speech service failed", error);
      // Mid-sentence, what already played stands: starting over in another voice would be worse.
      if (playing) {
        lipSync.stop();
        done();
      } else {
        this.speakFallback(sentence.text, generation, done);
      }
    }
  }

  private async runningAudioContext(): Promise<AudioContext> {
    this.audioContext ??= new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE });
    const context = this.audioContext;
    if (context.state !== "running") {
      await Promise.race([
        context.resume(),
        new Promise((resolve) => setTimeout(resolve, AUDIO_RESUME_TIMEOUT_MS)),
      ]);
    }
    if (context.state !== "running") throw new Error("Audio is blocked by the browser");
    return context;
  }

  /** The browser's local voice, or a silent timer when there is none. */
  private speakFallback(next: string, generation: number, done: () => void): void {
    if (!this.synth || !this.voice) {
      this.handlers.onNoVoice();
      this.markStarted();
      const duration = silentDuration(next);
      lipSync.start(next, this.lang, 1, duration);
      setTimeout(done, duration);
      return;
    }

    const utterance = new SpeechSynthesisUtterance(next);
    utterance.lang = LOCALES[this.lang];
    utterance.voice = this.voice;
    utterance.rate = 1.02;
    utterance.onstart = () => {
      if (generation !== this.generation) return;
      this.markStarted();
      lipSync.start(next, this.lang, utterance.rate);
    };
    utterance.onboundary = (event) => {
      if (generation === this.generation && event.name === "word") lipSync.boundary(event.charIndex);
    };
    utterance.onend = utterance.onerror = () => {
      if (generation === this.generation) lipSync.stop();
      done();
    };
    this.current = utterance;
    this.synth.speak(utterance);
  }

  private markStarted(): void {
    signals.speaking = true;
    if (this.started) return;
    this.started = true;
    this.handlers.onStart();
  }

  private pickVoice(): void {
    const voices = this.synth?.getVoices() ?? [];
    const matching = voices.filter((v) => voiceMatches(v.lang, this.lang) && !isCloudVoice(v));
    const mandarin = this.lang === "zh" ? matching.filter((v) => /^(zh-cn|zh-hans|cmn)/i.test(v.lang.replace("_", "-"))) : matching;
    const pool = mandarin.length ? mandarin : matching;
    this.voice =
      pool.find((v) => isMaleVoiceName(v.name)) ?? pool.find((v) => LOCAL_HINT.test(v.name)) ?? pool.find((v) => v.default) ?? pool[0] ?? null;
  }
}

/** Mandarin is about four syllables a second; everything else stays near 170 words a minute. */
function silentDuration(text: string): number {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const words = text.replace(/\p{Script=Han}/gu, " ").split(/\s+/).filter(Boolean).length;
  return Math.max(800, han * 240 + words * 350);
}

function voiceMatches(voiceLang: string, lang: Lang): boolean {
  const code = voiceLang.toLowerCase().replace("_", "-");
  if (lang === "zh") return code.startsWith("zh") || code.startsWith("cmn");
  return code.startsWith(lang);
}
