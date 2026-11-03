import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { Lang, Turn } from "../../shared/protocol";
import { MAX_HISTORY_TURNS } from "../../shared/protocol";
import { signals } from "../avatar/signals";
import { askStream } from "../llm/askStream";
import { SentenceChunker } from "../llm/sentences";
import { MicLevel } from "../voice/micLevel";
import { SpeechInput, isSttSupported, type SttErrorKind } from "../voice/stt";
import { SpeechOutput } from "../voice/tts";
import { initialState, reduce } from "./machine";
import { metrics } from "./metrics";

const STT_ERRORS: Record<SttErrorKind, Record<Lang, string>> = {
  denied: {
    en: "I can't hear you: microphone access is blocked. You can type your question instead.",
    fr: "Je ne t'entends pas : l'accès au micro est bloqué. Tu peux écrire ta question à la place.",
    zh: "我听不见：麦克风被关掉了。你也可以直接把问题打出来。",
  },
  "no-speech": { en: "", fr: "", zh: "" },
  unavailable: {
    en: "Couldn't load the free speech model (check the network, then try the mic again). You can type instead.",
    fr: "Impossible de charger le modèle vocal (vérifie la connexion, puis réessaie). Tu peux aussi écrire.",
    zh: "免费语音模型加载失败（请检查网络后重试麦克风）。你也可以直接打字。",
  },
  other: {
    en: "Something went wrong with the microphone. You can type your question instead.",
    fr: "Un souci avec le micro. Tu peux écrire ta question à la place.",
    zh: "麦克风出了点问题。你也可以直接把问题打出来。",
  },
};

const ANSWER_FAILED: Record<Lang, string> = {
  en: "I lost my train of thought. Please try again!",
  fr: "J'ai perdu le fil. Réessaie, s'il te plaît !",
  zh: "我刚才走神了。请再试一次！",
};

const SERVER_KEY_MISSING: Record<Lang, string> = {
  en: "Bao isn't connected to the answer service yet. Try again later.",
  fr: "Bao n'est pas encore branché au service de réponses. Réessaie plus tard.",
  zh: "回答服务还没接好，请稍后再试。",
};

/**
 * Orchestrates one conversation: mic (on-device Whisper) or typed question →
 * /api/ask stream → sentence queue → local OS text-to-speech.
 */
export function useConversation() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [lang, setLang] = useState<Lang>("en");
  const langRef = useRef(lang);
  const history = useRef<Turn[]>([]);
  const request = useRef<AbortController | null>(null);

  const voice = useRef<{ stt: SpeechInput; tts: SpeechOutput; mic: MicLevel } | null>(null);
  const askRef = useRef<(question: string) => void>(() => {});
  const pending = useRef<{ question: string; answer: string } | null>(null);

  if (!voice.current) {
    voice.current = {
      mic: new MicLevel(),
      stt: new SpeechInput({
        onInterim: (text) => dispatch({ type: "TRANSCRIPT", text }),
        onFinal: (text) => {
          voice.current?.mic.stop();
          askRef.current(text);
        },
        onNothing: (error) => {
          voice.current?.mic.stop();
          const message = error ? STT_ERRORS[error][langRef.current] : "";
          dispatch({ type: "NOTHING_HEARD", error: message || undefined });
        },
      }),
      tts: new SpeechOutput({
        onStart: () => {
          metrics.mark("firstAudio");
          dispatch({ type: "SPEECH_START" });
        },
        onDone: () => {
          const exchange = pending.current;
          if (exchange?.answer) {
            history.current = [
              ...history.current,
              { role: "user" as const, text: exchange.question },
              { role: "assistant" as const, text: exchange.answer },
            ].slice(-MAX_HISTORY_TURNS);
          }
          pending.current = null;
          dispatch({ type: "SPEECH_END" });
        },
      }),
    };
  }
  const { stt, tts, mic } = voice.current;

  const interrupt = useCallback(() => {
    stt.abort();
    mic.stop();
    request.current?.abort();
    request.current = null;
    pending.current = null;
    tts.reset();
  }, [stt, mic, tts]);

  const ask = useCallback(
    (question: string) => {
      const text = question.trim();
      if (!text) return;
      interrupt();
      metrics.begin();
      dispatch({ type: "QUESTION", text });

      const controller = new AbortController();
      request.current = controller;
      const chunker = new SentenceChunker();
      const exchange = { question: text, answer: "" };
      pending.current = exchange;

      askStream(
        { question: text, lang: langRef.current, history: history.current },
        (event) => {
          if (controller.signal.aborted) return;
          switch (event.type) {
            case "verdict":
              metrics.mark("verdict");
              metrics.provider(event.provider);
              signals.refusing = !event.inScope;
              dispatch({ type: "VERDICT", inScope: event.inScope });
              break;
            case "delta":
              metrics.mark("firstText");
              exchange.answer += event.text;
              dispatch({ type: "ANSWER_DELTA", text: event.text });
              chunker.push(event.text).forEach((s) => tts.enqueue(s));
              break;
            case "done":
              metrics.mark("complete");
              chunker.flush().forEach((s) => tts.enqueue(s));
              tts.finish();
              break;
            case "error":
              throw new Error(event.message);
          }
        },
        controller.signal,
      ).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error(error);
        tts.reset();
        const missing = error instanceof Error && error.message === "missing-key";
        dispatch({
          type: "FAIL",
          message: missing ? SERVER_KEY_MISSING[langRef.current] : ANSWER_FAILED[langRef.current],
        });
      });
    },
    [interrupt, tts],
  );
  askRef.current = ask;

  const listen = useCallback(() => {
    interrupt();
    dispatch({ type: "LISTEN" });
    void mic.start();
    stt.start(langRef.current);
  }, [interrupt, mic, stt]);

  const toggleMic = useCallback(() => {
    if (state.status === "listening") stt.stop();
    else listen();
  }, [state.status, stt, listen]);

  const changeLang = useCallback(
    (next: Lang) => {
      interrupt();
      langRef.current = next;
      history.current = [];
      tts.setLang(next);
      setLang(next);
      dispatch({ type: "RESET" });
    },
    [interrupt, tts],
  );

  useEffect(() => {
    if (state.status !== "error") return;
    const timer = setTimeout(() => dispatch({ type: "RESET" }), 5000);
    return () => clearTimeout(timer);
  }, [state.status]);

  useEffect(() => {
    signals.phase = state.status;
  }, [state.status]);

  useEffect(() => interrupt, [interrupt]);

  return {
    state,
    lang,
    sttSupported: isSttSupported(),
    toggleMic,
    ask,
    interrupt: () => {
      interrupt();
      dispatch({ type: "SPEECH_END" });
    },
    changeLang,
  };
}
