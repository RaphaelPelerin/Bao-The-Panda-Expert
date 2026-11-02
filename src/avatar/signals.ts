import type { Phase } from "../state/machine";

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
  /** performance.now() of the last spoken word boundary, drives mouth pulses. */
  wordAt: 0,
  /** Whether the last answer was a polite refusal. */
  refusing: false,
};

/**
 * How open the mouth should be right now, 0..1. Browser TTS gives no audio
 * samples, so this combines word-boundary events with a syllable-rate wobble.
 */
export function mouthOpenness(now: number): number {
  if (!signals.speaking) return 0;
  const sinceWord = (now - signals.wordAt) / 1000;
  const wordEnergy = Math.exp(-sinceWord * 3.5);
  const syllables = Math.abs(Math.sin(now * 0.0185)) * 0.7 + Math.abs(Math.sin(now * 0.031 + 1.3)) * 0.3;
  return Math.min(1, (0.35 + 0.65 * wordEnergy) * syllables);
}
