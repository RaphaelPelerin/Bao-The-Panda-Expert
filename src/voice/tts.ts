import type { Lang } from "../../shared/protocol";
import { lipSync } from "../avatar/lipsync";
import { signals } from "../avatar/signals";

export interface TtsHandlers {
  /** First sentence of an answer became audible. */
  onStart(): void;
  /** Every queued sentence finished and the answer is complete. */
  onDone(): void;
}

const LOCALES: Record<Lang, string> = { en: "en-US", fr: "fr-FR", zh: "zh-CN" };
/** Prefer voices that ship with the OS. */
const LOCAL_HINT = /local|desktop|offline|microsoft|apple|siri|samantha|ting-ting|mei-jia|sin-ji|xiaoxiao|xiaoyi|yunxia|yunyang|huihui|kangkang|hanhan|yaoyao/i;

/** Google and "Online" cloud voices are never used. */
export function isCloudVoice(voice: { name: string; voiceURI?: string }): boolean {
  return /google|\bonline\b/i.test(`${voice.name} ${voice.voiceURI ?? ""}`);
}

/**
 * Sentence queue over the browser's free local speechSynthesis. No Google
 * speech and no paid/LLM speech API. Cloud voices are skipped. Without a
 * matching local voice it runs a silent timer so the conversation still moves.
 */
export class SpeechOutput {
  private queue: string[] = [];
  private finished = false;
  private active = false;
  private started = false;
  private generation = 0;
  private lang: Lang = "en";
  private voice: SpeechSynthesisVoice | null = null;
  // Chrome can garbage-collect a playing utterance and drop its events; keep a reference.
  private current: SpeechSynthesisUtterance | null = null;
  private readonly synth = typeof speechSynthesis === "undefined" ? null : speechSynthesis;

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
    this.queue.push(text);
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
      this.pump();
    };

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
    utterance.pitch = 1.12;
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
    this.voice = pool.find((v) => LOCAL_HINT.test(v.name)) ?? pool.find((v) => v.default) ?? pool[0] ?? null;
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
