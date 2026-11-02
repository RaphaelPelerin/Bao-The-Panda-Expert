// Latency marks for the last exchange, shown in the debug panel (press D).
// All values are milliseconds measured from the moment the question was final.

export interface Latency {
  provider: string | null;
  /** Server decided whether the question is about pandas. */
  verdict: number | null;
  /** First answer text arrived. */
  firstText: number | null;
  /** The panda's voice became audible. */
  firstAudio: number | null;
  /** Answer fully generated. */
  complete: number | null;
}

const empty: Latency = { provider: null, verdict: null, firstText: null, firstAudio: null, complete: null };

let origin = 0;
let current: Latency = { ...empty };
const listeners = new Set<(l: Latency) => void>();

export const metrics = {
  begin(): void {
    origin = performance.now();
    current = { ...empty };
    listeners.forEach((l) => l(current));
  },
  mark(key: Exclude<keyof Latency, "provider">): void {
    if (current[key] !== null) return;
    current = { ...current, [key]: Math.round(performance.now() - origin) };
    listeners.forEach((l) => l(current));
  },
  provider(name: string): void {
    current = { ...current, provider: name };
    listeners.forEach((l) => l(current));
  },
  subscribe(listener: (l: Latency) => void): () => void {
    listeners.add(listener);
    listener(current);
    return () => listeners.delete(listener);
  },
};
