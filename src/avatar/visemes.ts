import type { Lang } from "../../shared/protocol";

/**
 * Mouth shapes, as a target in the mouth atlas space: `open` 0 (lips closed)
 * to 1 (widest open), `wide` 0 (rounded, pursed) to 1 (spread smile).
 * `length` is the relative duration of the sound.
 */
export const VISEMES = {
  sil: { open: 0, wide: 0.5, length: 1 },
  PP: { open: 0, wide: 0.4, length: 0.9 }, // m b p: lips pressed
  FF: { open: 0.15, wide: 0.6, length: 0.85 }, // f v
  TH: { open: 0.25, wide: 0.6, length: 0.8 },
  DD: { open: 0.3, wide: 0.6, length: 0.7 }, // t d n l
  kk: { open: 0.4, wide: 0.55, length: 0.7 }, // k g h
  CH: { open: 0.3, wide: 0.15, length: 0.9 }, // ch sh j: lips pushed out
  SS: { open: 0.15, wide: 0.85, length: 0.85 }, // s z: teeth together
  RR: { open: 0.3, wide: 0.3, length: 0.75 },
  aa: { open: 0.95, wide: 0.6, length: 1.3 }, // a
  ah: { open: 0.6, wide: 0.5, length: 1.1 }, // short "uh"
  E: { open: 0.55, wide: 0.85, length: 1.15 }, // e é è
  I: { open: 0.35, wide: 0.95, length: 1.1 }, // i ee y
  O: { open: 0.75, wide: 0.15, length: 1.25 }, // o
  U: { open: 0.35, wide: 0, length: 1.15 }, // u oo ou w
} as const;

export type Viseme = keyof typeof VISEMES;

/** One spoken word (or pause), with where it sits in the utterance text. */
export interface Token {
  /** Character index in the utterance, as reported by speech boundary events. */
  charIndex: number;
  visemes: Viseme[];
  /** A pause after punctuation rather than a word. */
  pause?: boolean;
}

type Rule = [pattern: string, visemes: Viseme[]];

// Longest patterns first; "$" anchors a pattern to the end of the word.
const RULES: Record<Lang, Rule[]> = {
  en: [
    ["igh", ["aa", "I"]],
    ["tion", ["CH", "ah", "DD"]],
    ["ture", ["CH", "RR"]],
    ["ough", ["O"]],
    ["th", ["TH"]],
    ["sh", ["CH"]],
    ["ch", ["CH"]],
    ["ph", ["FF"]],
    ["wh", ["U"]],
    ["ck", ["kk"]],
    ["ng", ["kk"]],
    ["qu", ["kk", "U"]],
    ["oo", ["U"]],
    ["ee", ["I"]],
    ["ea", ["I"]],
    ["ou", ["aa", "U"]],
    ["ow", ["O", "U"]],
    ["oa", ["O"]],
    ["oi", ["O", "I"]],
    ["oy", ["O", "I"]],
    ["ai", ["E", "I"]],
    ["ay", ["E", "I"]],
    ["au", ["O"]],
    ["aw", ["O"]],
    ["er", ["RR"]],
    ["ir", ["RR"]],
    ["ur", ["RR"]],
    ["ar", ["aa", "RR"]],
    ["or", ["O", "RR"]],
    ["e$", []], // Silent final e.
    ["es$", ["SS"]],
    ["ed$", ["DD"]],
    ["a", ["aa"]],
    ["e", ["E"]],
    ["i", ["I"]],
    ["o", ["O"]],
    ["u", ["ah"]],
    ["y", ["I"]],
  ],
  fr: [
    ["eaux", ["O"]],
    ["eau", ["O"]],
    ["ain", ["E"]],
    ["ein", ["E"]],
    ["oin", ["U", "E"]],
    ["gent$", ["CH"]], // "mangent", before "ge" eats the e
    ["ent$", []], // "ils parlent"
    ["oi", ["U", "aa"]],
    ["ou", ["U"]],
    ["où", ["U"]],
    ["au", ["O"]],
    ["ai", ["E"]],
    ["ei", ["E"]],
    ["eu", ["O"]],
    ["œu", ["O"]],
    ["an", ["aa"]],
    ["am", ["aa"]],
    ["en", ["aa"]],
    ["em", ["aa"]],
    ["on", ["O"]],
    ["om", ["O"]],
    ["in", ["E"]],
    ["im", ["E"]],
    ["un", ["E"]],
    ["er$", ["E"]],
    ["ez$", ["E"]],
    ["et$", ["E"]],
    ["ch", ["CH"]],
    ["gn", ["DD", "I"]],
    ["qu", ["kk"]],
    ["ph", ["FF"]],
    ["th", ["DD"]],
    ["ll", ["DD"]],
    ["ge", ["CH"]],
    ["gi", ["CH", "I"]],
    ["es$", []],
    ["e$", []],
    ["s$", []],
    ["t$", []],
    ["x$", []],
    ["d$", []],
    ["p$", []], // "beaucoup", "trop"
    ["z$", []],
    ["h", []],
    ["a", ["aa"]],
    ["à", ["aa"]],
    ["â", ["aa"]],
    ["e", ["ah"]],
    ["é", ["E"]],
    ["è", ["E"]],
    ["ê", ["E"]],
    ["ë", ["E"]],
    ["i", ["I"]],
    ["î", ["I"]],
    ["ï", ["I"]],
    ["y", ["I"]],
    ["o", ["O"]],
    ["ô", ["O"]],
    ["u", ["U"]],
    ["û", ["U"]],
    ["ù", ["U"]],
    ["ç", ["SS"]],
    ["j", ["CH"]],
  ],
};

const CONSONANTS: Record<string, Viseme> = {
  b: "PP",
  m: "PP",
  p: "PP",
  f: "FF",
  v: "FF",
  t: "DD",
  d: "DD",
  n: "DD",
  l: "DD",
  s: "SS",
  z: "SS",
  c: "kk",
  k: "kk",
  g: "kk",
  q: "kk",
  x: "kk",
  h: "kk",
  j: "CH",
  r: "RR",
  w: "U",
};

const WORD = /[\p{L}\p{N}'’]+/gu;
const PAUSE = /[,;:]|[.!?…]+/g;

/** Splits an utterance into words and pauses, each with its mouth shapes. */
export function tokenize(text: string, lang: Lang): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(WORD)) tokens.push({ charIndex: match.index!, visemes: wordVisemes(match[0], lang) });
  for (const match of text.matchAll(PAUSE)) {
    const long = /[.!?…]/.test(match[0]);
    tokens.push({ charIndex: match.index!, visemes: long ? ["sil", "sil", "sil"] : ["sil", "sil"], pause: true });
  }
  return tokens.sort((a, b) => a.charIndex - b.charIndex);
}

/** Grapheme rules, good enough to drive a cartoon mouth (not a phonetic transcription). */
export function wordVisemes(word: string, lang: Lang): Viseme[] {
  const w = word.toLowerCase().replace(/['’]/g, "");
  if (/^\d+$/.test(w)) return digitsVisemes(w.length);
  const rules = RULES[lang];
  const out: Viseme[] = [];
  let i = 0;
  while (i < w.length) {
    let matched = false;
    for (const [pattern, visemes] of rules) {
      const atEnd = pattern.endsWith("$");
      const p = atEnd ? pattern.slice(0, -1) : pattern;
      if (!w.startsWith(p, i)) continue;
      // Keep the word's only vowel, even when a rule calls it silent ("le", "the").
      if (atEnd && (i + p.length !== w.length || (visemes.length === 0 && out.every((v) => !isVowel(v))))) continue;
      out.push(...visemes);
      i += p.length;
      matched = true;
      break;
    }
    if (matched) continue;
    const letter = w[i].normalize("NFD")[0];
    const consonant = CONSONANTS[letter];
    // Double letters are one sound.
    if (consonant && out[out.length - 1] !== consonant) out.push(consonant);
    i++;
  }
  return out.length ? out : ["ah"];
}

function isVowel(v: Viseme): boolean {
  return v === "aa" || v === "ah" || v === "E" || v === "I" || v === "O" || v === "U";
}

function digitsVisemes(count: number): Viseme[] {
  const cycle: Viseme[] = ["DD", "aa", "SS", "E", "FF", "O"];
  return Array.from({ length: count * 3 }, (_, i) => cycle[i % cycle.length]);
}
