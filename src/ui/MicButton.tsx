import { useEffect, useRef } from "react";
import type { Phase } from "../state/machine";
import { signals } from "../avatar/signals";
import { MicIcon, StopIcon } from "./icons";

interface Props {
  phase: Phase;
  label: string;
  onPress: () => void;
}

export function MicButton({ phase, label, onPress }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const busy = phase === "thinking" || phase === "speaking";

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      ref.current?.style.setProperty("--level", signals.micLevel.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <button
      ref={ref}
      className="mic"
      data-phase={phase}
      aria-label={label}
      title={label}
      onClick={onPress}
    >
      <span className="mic-ring" aria-hidden />
      <span className="mic-ring mic-ring--2" aria-hidden />
      <span className="mic-core">{phase === "listening" || busy ? <StopIcon /> : <MicIcon />}</span>
    </button>
  );
}
