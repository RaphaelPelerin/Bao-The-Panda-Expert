import type { Lang } from "../../shared/protocol";
import { tokenize, VISEMES, type Token, type Viseme } from "./visemes";

/** Seconds per unit of viseme length at rate 1: about 13 sounds a second. */
const BASE_UNIT = 0.072;
/** Short gap between words, in units. */
const WORD_GAP = 0.35;
/** Share of each sound spent moving toward the next one (coarticulation). */
const BLEND = 0.45;

interface Segment {
  viseme: Viseme;
  start: number;
  end: number;
}

interface Word {
  charIndex: number;
  /** Start in timeline units. */
  start: number;
}

export interface MouthShape {
  open: number;
  wide: number;
  /** 0 when silent, 1 while speaking: fades the pasted mouth in and out. */
  active: number;
}

/**
 * Lip-sync clock for one utterance at a time. Browser speech synthesis gives no
 * audio samples, only word boundary events (and some voices give none), so the
 * text is turned into a viseme timeline whose speed is estimated, then pulled
 * back onto the real speech at every boundary.
 */
class LipSync {
  private segments: Segment[] = [];
  private words: Word[] = [];
  private total = 0;
  /** performance.now() at timeline unit 0. */
  private origin = 0;
  /** Milliseconds per timeline unit. */
  private msPerUnit = BASE_UNIT * 1000;
  /** Learned from boundaries, carried across sentences: the voice's real pace. */
  private learnedPace = 1;
  private lastBoundary: { at: number; unit: number } | null = null;
  private speaking = false;
  private stoppedAt = -Infinity;

  /** An utterance just became audible. `durationMs`, when known, stretches the timeline to fit it. */
  start(text: string, lang: Lang, rate = 1, durationMs?: number): void {
    this.build(tokenize(text, lang));
    this.msPerUnit = durationMs && this.total > 0 ? durationMs / this.total : (BASE_UNIT * 1000 * this.learnedPace) / rate;
    this.origin = performance.now();
    this.lastBoundary = null;
    this.speaking = true;
  }

  /** A word boundary event: the word at `charIndex` starts now. */
  boundary(charIndex: number): void {
    if (!this.speaking || !this.words.length) return;
    const word = this.words.reduce((best, w) => (Math.abs(w.charIndex - charIndex) < Math.abs(best.charIndex - charIndex) ? w : best));
    const now = performance.now();
    if (this.lastBoundary && word.start > this.lastBoundary.unit) {
      const measured = (now - this.lastBoundary.at) / (word.start - this.lastBoundary.unit);
      // Ignore outliers (a long pause, a late event), then follow the real pace smoothly.
      if (measured > 20 && measured < 250) {
        this.msPerUnit += (measured - this.msPerUnit) * 0.35;
        this.learnedPace += (this.msPerUnit / (BASE_UNIT * 1000) - this.learnedPace) * 0.2;
      }
    }
    this.origin = now - word.start * this.msPerUnit;
    this.lastBoundary = { at: now, unit: word.start };
  }

  stop(): void {
    if (this.speaking) this.stoppedAt = performance.now();
    this.speaking = false;
  }

  /** The mouth shape to show at `now` (performance.now()). */
  sample(now: number): MouthShape {
    const fadeOut = Math.max(0, 1 - (now - this.stoppedAt) / 180);
    if (!this.speaking || !this.segments.length) return { ...VISEMES.sil, active: fadeOut };

    const t = (now - this.origin) / this.msPerUnit;
    // Ran ahead of the voice (or the voice paused): rest with the lips closed.
    if (t < 0 || t >= this.total) return { open: 0, wide: VISEMES.sil.wide, active: 1 };

    let i = this.segments.findIndex((s) => t < s.end);
    if (i < 0) i = this.segments.length - 1;
    const segment = this.segments[i];
    const next = this.segments[i + 1];
    const a = VISEMES[segment.viseme];
    const progress = (t - segment.start) / (segment.end - segment.start);
    const towardNext = next ? smoothstep(1 - BLEND, 1, progress) * 0.5 : 0;
    const b = next ? VISEMES[next.viseme] : a;
    return {
      open: a.open + (b.open - a.open) * towardNext,
      wide: a.wide + (b.wide - a.wide) * towardNext,
      active: 1,
    };
  }

  private build(tokens: Token[]): void {
    this.segments = [];
    this.words = [];
    let cursor = 0;
    for (const token of tokens) {
      if (!token.pause) this.words.push({ charIndex: token.charIndex, start: cursor });
      for (const viseme of token.visemes) {
        const length = VISEMES[viseme].length;
        this.segments.push({ viseme, start: cursor, end: cursor + length });
        cursor += length;
      }
      if (!token.pause) {
        this.segments.push({ viseme: "sil", start: cursor, end: cursor + WORD_GAP });
        cursor += WORD_GAP;
      }
    }
    this.total = cursor;
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export const lipSync = new LipSync();
