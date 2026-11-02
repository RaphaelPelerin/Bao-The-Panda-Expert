/** Shared by every swaying material so bamboo, leaves and particles move as one wind. */
export const windUniforms = {
  uTime: { value: 0 },
  /** 1 is a calm breeze; the user's voice pushes it higher. */
  uWind: { value: 1 },
};

/** Deterministic random numbers so the scene is identical on every load. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
