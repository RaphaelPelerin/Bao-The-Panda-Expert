import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { Lang, Turn, Usage } from "../../shared/protocol";
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

const DAILY_LIMIT_REACHED: Record<Lang, string> = {
  en: "That's all the questions I can answer today. Come back tomorrow!",
  fr: "J'ai répondu à toutes les questions possibles pour aujourd'hui. Reviens demain !",
  zh: "今天能回答的问题已经用完了，明天再来吧！",
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
 * /api/ask stream → sentence queue → streamed text-to-speech.
 */
export function useConversation() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [lang, setLang] = useState<Lang>("en");
  const [noVoice, setNoVoice] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
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
        onNoVoice: () => setNoVoice(true),
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

  const refreshUsage = useCallback(async () => {
    try {
      const response = await fetch("/api/ask");
      if (response.ok) setUsage((await response.json()) as Usage | null);
    } catch {
      // The counter is informative: without it, the panda still answers.
    }
  }, []);

  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage]);

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
            case "usage":
              setUsage({ used: event.used, max: event.max, approximate: event.approximate });
              break;
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
        const reason = error instanceof Error ? error.message : "";
        if (reason === "daily-limit") void refreshUsage();
        const messages: Record<string, Record<Lang, string>> = { "missing-key": SERVER_KEY_MISSING, "daily-limit": DAILY_LIMIT_REACHED };
        dispatch({ type: "FAIL", message: (messages[reason] ?? ANSWER_FAILED)[langRef.current] });
      });
    },
    [interrupt, tts, refreshUsage],
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
      dispatch({ type: "CLEAR" });
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
    noVoice,
    usage,
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
