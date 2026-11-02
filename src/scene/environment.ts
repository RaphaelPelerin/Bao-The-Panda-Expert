import * as THREE from "three";

// Shared look of the landscape: the panda stands on a bamboo-covered hilltop
// overlooking a misty lake, a village and karst mountains.

/** Height of the lake surface. */
export const WATER_Y = -5.5;
/** Height of the hilltop where the panda and the bamboo stand. */
export const HILLTOP_Y = -1;

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * Ground height: a flat hilltop that drops to the lake just behind the panda
 * (so the camera can see down into the valley), rising again far to the sides.
 * Shared by the terrain mesh and the bamboo, which must stand on it.
 */
export function groundHeight(x: number, z: number): number {
  const down = smoothstep(-4.5, -13, z);
  const bumps = Math.sin(x * 0.31) * Math.cos(z * 0.43) * 0.2;
  const valleySides = Math.min(10, Math.max(0, Math.abs(x) - 26) * 0.4) * down;
  return HILLTOP_Y + (WATER_Y - 2 - HILLTOP_Y) * down + bumps + valleySides;
}

/** Direction toward the sun: low over the lake, slightly to the right. */
export const SUN_DIRECTION = new THREE.Vector3(0.32, 0.12, -1).normalize();

/** Color of the distant haze; the sky's horizon, the fog and the mountain mist blend into it. */
export const HAZE = new THREE.Color("#d6e2cf");
export const SKY_HIGH = new THREE.Color("#7fa7a0");
