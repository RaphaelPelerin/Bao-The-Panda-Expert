import { describe, expect, it, vi } from "vitest";
import { LoadTracker } from "../src/loading";

const tracker = () => new LoadTracker({ small: 1, big: 3 });

describe("load tracker", () => {
  it("weighs items and reaches exactly 1", () => {
    const load = tracker();
    expect(load.progress).toBe(0);
    load.report("small");
    expect(load.progress).toBe(0.25);
    load.report("big");
    expect(load.progress).toBe(1);
  });

  it("counts part of an item", () => {
    const load = tracker();
    load.report("big", 0.5);
    expect(load.progress).toBe(0.375);
  });

  it("never goes backwards", () => {
    const load = tracker();
    load.report("big", 0.8);
    load.report("big", 0.2);
    expect(load.progress).toBeCloseTo(0.6);
  });

  it("counts a failed item as finished", async () => {
    const load = tracker();
    load.track("small", Promise.reject(new Error("no file")));
    load.track("big", Promise.resolve());
    await new Promise((resolve) => setTimeout(resolve));
    expect(load.progress).toBe(1);
  });

  it("tells listeners only when progress changes, until they unsubscribe", () => {
    const load = tracker();
    const listener = vi.fn();
    const stop = load.subscribe(listener);
    load.report("small");
    load.report("small");
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    load.report("big");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
