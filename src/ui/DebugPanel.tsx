import { useEffect, useState } from "react";
import { signals } from "../avatar/signals";
import { metrics, type Latency } from "../state/metrics";

const ROWS: [keyof Latency, string][] = [
  ["verdict", "Topic verdict"],
  ["firstText", "First text"],
  ["firstAudio", "First audio"],
  ["complete", "Answer complete"],
];

/** Time from the end of the question to each milestone of the last answer. */
export function DebugPanel({ title }: { title: string }) {
  const [latency, setLatency] = useState<Latency | null>(null);
  const [render, setRender] = useState({ fps: 0, scale: 1 });
  useEffect(() => metrics.subscribe(setLatency), []);
  useEffect(() => {
    const timer = setInterval(() => setRender({ fps: signals.fps, scale: signals.renderScale }), 500);
    return () => clearInterval(timer);
  }, []);
  if (!latency) return null;

  return (
    <aside className="debug glass" aria-label={title}>
      <h2>{title}</h2>
      <dl>
        <div className="debug-row">
          <dt>Provider</dt>
          <dd>{latency.provider ?? "—"}</dd>
        </div>
        {ROWS.map(([key, label]) => (
          <div key={key} className="debug-row">
            <dt>{label}</dt>
            <dd>{latency[key] === null ? "—" : `${latency[key]} ms`}</dd>
          </div>
        ))}
        <div className="debug-row">
          <dt>Frame rate</dt>
          <dd>{render.fps ? `${render.fps} fps · ×${render.scale.toFixed(1)}` : "—"}</dd>
        </div>
      </dl>
    </aside>
  );
}
