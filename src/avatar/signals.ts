import type { Phase } from "../state/machine";
import { lipSync } from "./lipsync";

/**
 * Per-frame values shared between the voice layer and the 3D scene. Kept in a
 * plain mutable object (not React state) so audio levels can update 60 times a
 * second without re-rendering the UI.
 */
export const signals = {
  phase: "idle" as Phase,
  /** Microphone loudness, 0..1, smoothed. */
  micLevel: 0,
  /** True while the panda's voice is audible. */
  speaking: false,
  /** Whether the last answer was a polite refusal. */
  refusing: false,
  /** Measured frame rate and current render scale, shown in the debug panel. */
  fps: 0,
  renderScale: 1,
};

/** How open the mouth should be right now, 0..1, following the words being spoken. */
export function mouthOpenness(now: number): number {
  if (!signals.speaking) return 0;
  return lipSync.sample(now).open;
}
