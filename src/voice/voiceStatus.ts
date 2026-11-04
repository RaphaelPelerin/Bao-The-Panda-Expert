import type { Lang } from "../../shared/protocol";

/**
 * Piper voice per language. Bao is a male character. Medium quality: about 63 MB
 * each, downloaded once per browser. Chinese has no male voice this engine can
 * run (its only other voices need a pinyin phonemizer), so Huayan, a female
 * voice, is what's left: a local male voice takes priority over it.
 */
export const PIPER_VOICES: Record<Lang, string> = {
  en: "en_US-hfc_male-medium",
  fr: "fr_FR-tom-medium",
  zh: "zh_CN-huayan-medium",
};

const PIPER_VOICE_IS_MALE: Record<Lang, boolean> = { en: true, fr: true, zh: false };

/** Male voices that ship with Windows, macOS and Edge, by name. */
const MALE_LOCAL_VOICE =
  /\b(david|mark|guy|ryan|christopher|eric|george|james|richard|alex|daniel|fred|tom|aaron|arthur|oliver|paul|claude|henri|remy|antoine|thomas|nicolas|kangkang|yunxi|yunyang|yunjian|yunxia|li-mu)\b/i;

export function isMaleVoiceName(name: string): boolean {
  return MALE_LOCAL_VOICE.test(name);
}

export type PiperState = { state: "idle" | "ready" | "failed" } | { state: "loading"; percent: number };

export type VoiceEngine = "piper" | "local" | "silent";

/** Every sentence uses the best voice available right now, and a male one when possible. */
export function chooseEngine(lang: Lang, piperReady: boolean, localVoiceName: string | null): VoiceEngine {
  if (localVoiceName && !PIPER_VOICE_IS_MALE[lang] && isMaleVoiceName(localVoiceName)) return "local";
  if (piperReady) return "piper";
  return localVoiceName ? "local" : "silent";
}

export type VoiceNotice = { kind: "loading"; percent: number } | { kind: "none" } | null;

/** Only speak up when answers would otherwise be silent. */
export function voiceNotice(piper: PiperState, hasLocalVoice: boolean): VoiceNotice {
  if (hasLocalVoice || piper.state === "ready") return null;
  if (piper.state === "failed") return { kind: "none" };
  return { kind: "loading", percent: piper.state === "loading" ? piper.percent : 0 };
}
