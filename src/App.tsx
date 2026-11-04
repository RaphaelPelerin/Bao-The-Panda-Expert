import { Suspense, lazy, useEffect, useRef, useState, type FormEvent } from "react";
import { LANGS, type Lang } from "../shared/protocol";
import { loading } from "./loading";
import { BambooFrame } from "./scene/BambooFrame";
import { SceneBoundary } from "./scene/SceneBoundary";
import { useConversation } from "./state/useConversation";
import { DebugPanel } from "./ui/DebugPanel";
import { KeyboardIcon, LeafIcon, MicIcon, SendIcon } from "./ui/icons";
import { LoadingScreen } from "./ui/LoadingScreen";
import { MicButton } from "./ui/MicButton";
import { STRINGS } from "./ui/strings";

// three.js is the heaviest part of the bundle, so it gets its own chunk.
const sceneCode = import("./scene/Scene");
loading.track("code", sceneCode);
const Scene = lazy(() => sceneCode.then((m) => ({ default: m.Scene })));

const LANG_LABEL: Record<Lang, string> = { en: "EN", fr: "FR", zh: "中" };
const HTML_LANG: Record<Lang, string> = { en: "en", fr: "fr", zh: "zh-CN" };

export function App() {
  const { state, lang, noVoice, usage, sttSupported, toggleMic, ask, interrupt, changeLang } = useConversation();
  const t = STRINGS[lang];
  const [typing, setTyping] = useState(!sttSupported);
  const [draft, setDraft] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.lang = HTML_LANG[lang];
  }, [lang]);

  const busy = state.status === "thinking" || state.status === "speaking";
  const onMic = () => (busy ? interrupt() : toggleMic());

  // Space talks, Escape interrupts, D toggles the latency panel.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.repeat) return;
      if (event.code === "Space" && sttSupported && !typing) {
        event.preventDefault();
        onMic();
      } else if (event.code === "Escape") {
        interrupt();
      } else if (event.key.toLowerCase() === "d") {
        setShowDebug((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (typing) input.current?.focus();
  }, [typing, lang]);

  const subtitles = useRef<HTMLElement>(null);
  useEffect(() => {
    subtitles.current?.scrollTo({ top: subtitles.current.scrollHeight });
  }, [state.answer]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    ask(draft);
    setDraft("");
  };

  const status = state.status === "error" ? state.error : t.status[state.status];
  const hasExchange = Boolean(state.transcript || state.answer);

  return (
    <div className="app" data-phase={state.status}>
      <LoadingScreen label={t.loading} hint={t.loadingHint} />
      <SceneBoundary>
        <Suspense fallback={<div className="scene-loading" />}>
          <div className="scene">
            <Scene />
          </div>
        </Suspense>
      </SceneBoundary>
      <BambooFrame />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <LeafIcon />
          </span>
          <div>
            <h1>Bao</h1>
            <p>{t.tagline}</p>
          </div>
        </div>
        <div className="lang glass" role="group" aria-label={t.language}>
          {LANGS.map((code) => (
            <button key={code} aria-pressed={lang === code} onClick={() => changeLang(code)}>
              {LANG_LABEL[code]}
            </button>
          ))}
        </div>
      </header>

      <main className="dock">
        {hasExchange ? (
          <section ref={subtitles} className="subtitles glass" aria-live="polite">
            {state.transcript && (
              <p className="subtitle-user">
                <span>{t.you}</span> {state.transcript}
              </p>
            )}
            {state.answer ? (
              <p className={`subtitle-panda${state.inScope === false ? " is-refusal" : ""}`}>{state.answer}</p>
            ) : (
              state.status === "thinking" && (
                <p className="subtitle-panda subtitle-dots" aria-label={t.status.thinking}>
                  <i />
                  <i />
                  <i />
                </p>
              )
            )}
          </section>
        ) : (
          state.status === "idle" && (
            <ul className="suggestions" aria-label={t.suggestionsLabel}>
              {t.suggestions.map((s) => (
                <li key={s}>
                  <button className="chip glass" onClick={() => ask(s)}>
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          )
        )}

        {!sttSupported && <p className="notice glass">{t.noVoice}</p>}
        {noVoice && <p className="notice glass">{t.voiceUnavailable}</p>}

        <p className={`status${state.status === "error" ? " is-error" : ""}`} role="status">
          {status}
        </p>

        <div className="controls">
          {sttSupported && (
            <button
              className="icon-button glass"
              onClick={() => setTyping((v) => !v)}
              aria-label={typing ? t.useMic : t.typeInstead}
              title={typing ? t.useMic : t.typeInstead}
            >
              {typing ? <MicIcon /> : <KeyboardIcon />}
            </button>
          )}
          {sttSupported && !typing ? (
            <MicButton
              phase={state.status}
              label={state.status === "idle" || state.status === "error" ? t.micStart : t.micStop}
              onPress={onMic}
            />
          ) : (
            <form className="ask glass" onSubmit={submit}>
              <input
                ref={input}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t.placeholder}
                maxLength={500}
                aria-label={t.placeholder}
              />
              <button type="submit" aria-label={t.send} disabled={!draft.trim() || busy}>
                <SendIcon />
              </button>
            </form>
          )}
          {sttSupported && <span className="icon-button-spacer" aria-hidden />}
        </div>
      </main>

      {showDebug && <DebugPanel title={t.debug} />}

      {usage && (
        <p className="usage glass" title={t.usageHint}>
          {usage.approximate && "≈ "}
          {usage.max > 0 ? `${usage.used} / ${usage.max}` : usage.used} {t.usageLabel}
        </p>
      )}
    </div>
  );
}
