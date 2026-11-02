import * as THREE from "three";

/** Shared by every swaying material so stalks, leaves and particles move as one wind. */
export const windUniforms = {
  uTime: { value: 0 },
  /** 1 is a calm breeze; the user's voice pushes it higher. */
  uWind: { value: 1 },
};

/**
 * GLSL returning the horizontal (xz) displacement of a point on a stalk rooted
 * at `root`, at normalized height `h` (0 at the ground, 1 at the tip). Gusts
 * travel across the forest so neighbors bend together, not in lockstep.
 */
export const WIND_GLSL = /* glsl */ `
uniform float uTime;
uniform float uWind;

vec2 windOffset(vec3 root, float h) {
  float phase = root.x * 0.37 + root.z * 0.23;
  float gust = 0.5 + 0.5 * sin(uTime * 0.42 - root.x * 0.11 + root.z * 0.05);
  gust = gust * gust * gust;
  float sway = sin(uTime * 1.05 + phase) * 0.55 + sin(uTime * 2.4 + phase * 1.9) * 0.18;
  float bend = (0.35 + 1.1 * gust) * uWind;
  vec2 dir = vec2(sway + gust * 1.2, cos(uTime * 0.8 + phase) * 0.35);
  return dir * bend * h * h;
}
`;

/** Deterministic random numbers so the forest layout is identical on every load. */
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

export const tmpMatrix = new THREE.Matrix4();
