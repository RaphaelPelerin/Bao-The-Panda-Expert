import { useEffect, useRef } from "react";
import { signals } from "../avatar/signals";
import type { Phase } from "../state/machine";
import { MicIcon, StopIcon } from "./icons";

interface Props {
  phase: Phase;
  label: string;
  onPress(): void;
}

/** Round mic button. Its rings follow the user's voice level while listening. */
export function MicButton({ phase, label, onPress }: Props) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      ref.current?.style.setProperty("--level", signals.micLevel.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, []);

  const busy = phase === "speaking" || phase === "thinking";
  return (
    <button ref={ref} className="mic" data-phase={phase} onClick={onPress} aria-label={label} title={label}>
      <span className="mic-ring" aria-hidden />
      <span className="mic-ring mic-ring--2" aria-hidden />
      <span className="mic-core">{phase === "listening" || busy ? <StopIcon /> : <MicIcon />}</span>
    </button>
  );
}
