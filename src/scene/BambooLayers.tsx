import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { CAMERA_FOV, CAMERA_PITCH, CAMERA_POSITION } from "../avatar/Panda";
import { HAZE, groundHeight } from "./environment";
import { paintGrove, type GroveStyle } from "./paintBamboo";
import { windUniforms } from "./wind";

// The bamboo is illustrated, not modeled: each side of the screen gets three
// painted layers at different depths (hazy far grove, mid grove, dark close
// culms). Six textured planes replace thousands of meshes; the wind bends
// them in the vertex shader and the depth gives real parallax.

interface LayerSpec {
  z: number;
  /** Horizontal extent as a share of the visible half-width at that depth. */
  inner: number;
  outer: number;
  pixelsPerUnit: number;
  haze: number;
  sway: number;
  style: Omit<GroveStyle, "seed" | "widthUnits" | "heightUnits" | "pixelsPerUnit" | "crowdToward">;
}

const LAYERS: LayerSpec[] = [
  {
    z: -8,
    inner: 0.5,
    outer: 1.3,
    pixelsPerUnit: 70,
    haze: 0.5,
    sway: 0.6,
    style: { stalks: 16, thickness: [0.09, 0.15], leafiness: 0.9, leafLength: [0.4, 0.62], tone: 1.12 },
  },
  {
    z: -2.5,
    inner: 0.6,
    outer: 1.3,
    pixelsPerUnit: 110,
    haze: 0.18,
    sway: 0.75,
    style: { stalks: 10, thickness: [0.13, 0.21], leafiness: 0.85, leafLength: [0.38, 0.6], tone: 0.95 },
  },
  {
    z: 3.2,
    inner: 0.84,
    outer: 1.4,
    pixelsPerUnit: 260,
    haze: 0,
    sway: 0.35,
    style: { stalks: 2, thickness: [0.2, 0.28], leafiness: 0.35, leafLength: [0.4, 0.6], tone: 0.62 },
  },
];

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uWind;
  uniform float uSway;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    // Bend more toward the tops; neighbouring columns sway slightly out of phase.
    float h = uv.y * uv.y;
    float phase = world.x * 0.55 + world.z * 0.3;
    float gust = 0.5 + 0.5 * sin(uTime * 0.42 - world.x * 0.11);
    gust = gust * gust * gust;
    float sway = sin(uTime * 1.05 + phase) * 0.55 + sin(uTime * 2.4 + phase * 1.9) * 0.18 + gust * 1.1;
    world.x += sway * uSway * uWind * h;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uTime;
  uniform float uHaze;
  uniform vec3 uHazeColor;
  varying vec2 vUv;
  void main() {
    // Leaves flutter faster than the culms sway.
    vec2 uv = vUv + vec2(sin(uTime * 5.5 + vUv.y * 60.0) * 0.0015 * vUv.y, 0.0);
    vec4 texel = texture2D(uMap, uv);
    if (texel.a < 0.01) discard;
    // The texture is premultiplied: un-premultiply, haze, premultiply again.
    vec3 color = mix(texel.rgb / texel.a, uHazeColor, uHaze);
    gl_FragColor = vec4(color * texel.a, texel.a);
    #include <colorspace_fragment>
  }`;

interface Plane {
  key: string;
  position: [number, number, number];
  width: number;
  height: number;
  texture: THREE.CanvasTexture;
  material: THREE.ShaderMaterial;
  renderOrder: number;
}

function buildPlanes(aspect: number): Plane[] {
  const tan = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2));
  // Sharper paint on high-density screens, within reasonable texture sizes.
  const density = Math.min(window.devicePixelRatio || 1, 2);
  const planes: Plane[] = [];

  LAYERS.forEach((layer, layerIndex) => {
    const distance = CAMERA_POSITION.z - layer.z;
    // Phones show little width: bring the groves closer to the middle there.
    const inner = aspect < 0.85 ? layer.inner * 0.75 : layer.inner;
    const halfWidth = distance * tan * aspect;
    const width = (layer.outer - inner) * halfWidth;
    const viewTop = CAMERA_POSITION.y - distance * Math.tan(CAMERA_PITCH) + distance * tan;

    for (const side of [-1, 1]) {
      const centerX = side * ((inner + layer.outer) / 2) * halfWidth;
      const bottom = groundHeight(centerX, layer.z) - 0.4;
      const height = viewTop + 1.5 - bottom;
      const canvas = paintGrove({
        ...layer.style,
        seed: 101 + layerIndex * 17 + (side > 0 ? 7 : 0),
        widthUnits: width,
        heightUnits: height,
        pixelsPerUnit: Math.min(layer.pixelsPerUnit * density, 4096 / height),
        // Thickest toward the screen edge, thinning toward the open view.
        crowdToward: side > 0 ? 1 : 0,
      });
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.premultiplyAlpha = true;
      texture.anisotropy = 4;

      const material = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        premultipliedAlpha: true,
        uniforms: {
          uMap: { value: texture },
          uTime: windUniforms.uTime,
          uWind: windUniforms.uWind,
          uSway: { value: layer.sway },
          uHaze: { value: layer.haze },
          uHazeColor: { value: HAZE },
        },
        vertexShader,
        fragmentShader,
      });

      planes.push({
        key: `${layerIndex}-${side}`,
        position: [centerX, bottom + height / 2, layer.z],
        width,
        height,
        texture,
        material,
        // The closest layer stands in front of the panda (which draws late).
        renderOrder: layer.z > 1 ? 11 : 0,
      });
    }
  });
  return planes;
}

/** Painted bamboo groves framing both sides of the view, re-painted when the screen shape changes. */
export function BambooLayers() {
  const { size } = useThree();
  const aspect = Math.round((size.width / size.height) * 10) / 10;
  const planes = useMemo(() => buildPlanes(aspect), [aspect]);

  useEffect(
    () => () => {
      for (const plane of planes) {
        plane.texture.dispose();
        plane.material.dispose();
      }
    },
    [planes],
  );

  return (
    <group>
      {planes.map((plane) => (
        <mesh
          key={plane.key}
          position={plane.position}
          rotation-x={-CAMERA_PITCH}
          material={plane.material}
          renderOrder={plane.renderOrder}
          frustumCulled={false}
        >
          {/* Vertical segments so the wind can bend each plane smoothly. */}
          <planeGeometry args={[plane.width, plane.height, 1, 24]} />
        </mesh>
      ))}
    </group>
  );
}
