import type { Lang } from "../../shared/protocol";
import { lipSync } from "../avatar/lipsync";
import { signals } from "../avatar/signals";

export interface TtsHandlers {
  /** First sentence of an answer became audible. */
  onStart(): void;
  /** Every queued sentence finished and the answer is complete. */
  onDone(): void;
}

const LOCALES: Record<Lang, string> = { en: "en-US", fr: "fr-FR" };
const PREFERRED = /natural|neural|online|premium|enhanced|google/i;

/**
 * Sentence queue over speechSynthesis. Sentences can be added while the answer
 * is still streaming in, so the panda starts talking after the first sentence.
 * Without speechSynthesis it runs a silent timer so the rest of the app behaves
 * the same.
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

    if (!this.synth) {
      this.markStarted();
      // Roughly the pace of speech: about 170 words a minute.
      const duration = Math.max(800, next.split(/\s+/).length * 350);
      lipSync.start(next, this.lang, 1, duration);
      setTimeout(done, duration);
      return;
    }

    const utterance = new SpeechSynthesisUtterance(next);
    utterance.lang = LOCALES[this.lang];
    if (this.voice) utterance.voice = this.voice;
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
    const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(this.lang));
    this.voice = matching.find((v) => PREFERRED.test(v.name)) ?? matching.find((v) => v.default) ?? matching[0] ?? null;
  }
}
