import type { Lang } from "../../shared/protocol";
import { lipSync } from "../avatar/lipsync";
import { signals } from "../avatar/signals";
import { PiperVoice } from "./piperVoice";
import { chooseEngine, isMaleVoiceName, voiceNotice, type PiperState, type VoiceNotice } from "./voiceStatus";

export interface TtsHandlers {
  /** First sentence of an answer became audible. */
  onStart(): void;
  /** Every queued sentence finished and the answer is complete. */
  onDone(): void;
  /** Whether the visitor should be told that answers are silent for now. */
  onNotice(notice: VoiceNotice): void;
}

interface QueuedSentence {
  text: string;
  /** Piper's rendering, started as soon as the sentence arrives. Null when Piper isn't ready. */
  audio: Promise<ArrayBuffer | null> | null;
}

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
 * Sentence queue with free, on-device voices only: no cloud or paid speech API.
 * Each sentence uses Piper (neural voice in a worker) when it has loaded, else
 * the browser's local speechSynthesis (cloud voices are skipped), else a silent
 * timer so the conversation still moves.
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
  private readonly piper = new PiperVoice((state) => {
    this.piperState = state;
    this.reportNotice();
  });
  private piperState: PiperState = { state: "idle" };
  private audioContext: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;

  constructor(private readonly handlers: TtsHandlers) {
    this.synth?.addEventListener("voiceschanged", () => this.pickVoice());
    this.pickVoice();
  }

  setLang(lang: Lang): void {
    this.lang = lang;
    this.pickVoice();
    if (this.piperState.state !== "idle") this.piper.preload(lang);
  }

  /** Starts downloading the neural voice for the current language. */
  preload(): void {
    this.piper.preload(this.lang);
  }

  enqueue(sentence: string): void {
    const text = sentence.trim();
    if (!text) return;
    // Render right away, so the next sentence is often ready before the current one ends.
    const engine = chooseEngine(this.lang, this.piper.isReady(this.lang), this.voice?.name ?? null);
    const audio = engine === "piper" ? this.piper.synthesize(text).catch(logAndFallBack) : null;
    this.queue.push({ text, audio });
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
    if (this.current) this.current.onend = this.current.onerror = null;
    this.current = null;
    this.synth?.cancel();
    if (this.source) {
      this.source.onended = null;
      this.source.stop();
      this.source = null;
    }
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
      this.source = null;
      this.pump();
    };

    if (next.audio) {
      void this.playPiper(next, generation, done);
    } else {
      this.speakFallback(next.text, generation, done);
    }
  }

  /** Plays Piper's rendering, or falls back if it failed or can't be played. */
  private async playPiper(sentence: QueuedSentence, generation: number, done: () => void): Promise<void> {
    const wav = await sentence.audio;
    if (generation !== this.generation) return;
    try {
      if (!wav) throw new Error("no audio");
      const context = await this.runningAudioContext();
      const buffer = await context.decodeAudioData(wav);
      if (generation !== this.generation) return;

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (generation === this.generation) lipSync.stop();
        done();
      };
      this.source = source;
      source.start();
      this.markStarted();
      // Real audio: the mouth timeline can match its exact length.
      lipSync.start(sentence.text, this.lang, 1, buffer.duration * 1000);
    } catch (error) {
      if (generation !== this.generation) return;
      console.warn("[tts] Piper playback failed, using another voice", error);
      this.speakFallback(sentence.text, generation, done);
    }
  }

  private async runningAudioContext(): Promise<AudioContext> {
    this.audioContext ??= new AudioContext();
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
    this.reportNotice();
  }

  private reportNotice(): void {
    this.handlers.onNotice(voiceNotice(this.piperState, Boolean(this.voice)));
  }
}

function logAndFallBack(error: unknown): null {
  console.warn("[tts] Piper could not render a sentence", error);
  return null;
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
