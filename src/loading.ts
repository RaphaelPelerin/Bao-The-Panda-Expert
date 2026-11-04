/**
 * Everything the first screen waits for, weighted by roughly how long each
 * takes on a first visit. Whisper is the big one: its model and runtime are
 * tens of megabytes.
 */
const WEIGHTS = {
  fonts: 1,
  background: 3,
  bamboo: 3,
  code: 5,
  mouths: 4,
  idleVideo: 6,
  thinkVideo: 10,
  talkVideo: 10,
  panda: 3,
  whisper: 55,
};

export type LoadItem = keyof typeof WEIGHTS;

/** The items that can never finish if the 3D scene fails to start. */
export const SCENE_ITEMS: LoadItem[] = ["code", "mouths", "idleVideo", "thinkVideo", "talkVideo", "panda"];

/** Overall progress from 0 to 1. It only ever goes up, whatever order items report in. */
export class LoadTracker<Item extends string> {
  private readonly done = new Map<Item, number>();
  private readonly listeners = new Set<() => void>();
  private readonly total: number;
  progress = 0;

  constructor(private readonly weights: Record<Item, number>) {
    this.total = Object.values<number>(weights).reduce((sum, weight) => sum + weight, 0);
  }

  report(item: Item, fraction = 1): void {
    if (fraction <= (this.done.get(item) ?? 0)) return;
    this.done.set(item, Math.min(fraction, 1));
    let loaded = 0;
    for (const [key, value] of this.done) loaded += this.weights[key] * value;
    this.progress = loaded / this.total;
    for (const listener of this.listeners) listener();
  }

  /** A failed item also counts as finished: the app runs without it, so it must not hold the screen. */
  track(item: Item, work: Promise<unknown>): void {
    const finish = () => this.report(item);
    work.then(finish, finish);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const loading = new LoadTracker<LoadItem>(WEIGHTS);
