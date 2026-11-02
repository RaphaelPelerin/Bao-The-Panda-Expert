import type { Lang } from "../../shared/protocol";

// Thin wrapper over the Web Speech API recognizer (Chrome, Edge, Safari).
// Declared locally because webkitSpeechRecognition is not in the DOM typings.
interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function getCtor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const isSttSupported = (): boolean => getCtor() !== undefined;

export type SttErrorKind = "denied" | "no-speech" | "network" | "other";

export interface SttHandlers {
  onInterim(text: string): void;
  onFinal(text: string): void;
  /** Recognition ended without a final transcript (silence, abort, error). */
  onNothing(error?: SttErrorKind): void;
}

const LOCALES: Record<Lang, string> = { en: "en-US", fr: "fr-FR" };

export class SpeechInput {
  private recognition: Recognition | null = null;

  constructor(private readonly handlers: SttHandlers) {}

  start(lang: Lang): void {
    const Ctor = getCtor();
    if (!Ctor) {
      this.handlers.onNothing("other");
      return;
    }
    this.abort();

    const recognition = new Ctor();
    recognition.lang = LOCALES[lang];
    recognition.interimResults = true;
    // One utterance per press: the recognizer stops by itself after the user goes quiet.
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    let finalText = "";
    let error: SttErrorKind | undefined;

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (interim) this.handlers.onInterim(`${finalText}${interim}`.trim());
    };
    recognition.onerror = (event) => {
      error =
        event.error === "not-allowed" || event.error === "service-not-allowed"
          ? "denied"
          : event.error === "no-speech" || event.error === "aborted"
            ? "no-speech"
            : event.error === "network"
              ? "network"
              : "other";
    };
    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      this.recognition = null;
      const text = finalText.trim();
      if (text) this.handlers.onFinal(text);
      else this.handlers.onNothing(error);
    };

    this.recognition = recognition;
    recognition.start();
  }

  /** Stop listening and keep whatever was heard so far. */
  stop(): void {
    this.recognition?.stop();
  }

  /** Stop listening and drop the result, without calling any handler. */
  abort(): void {
    const recognition = this.recognition;
    this.recognition = null;
    recognition?.abort();
  }
}
