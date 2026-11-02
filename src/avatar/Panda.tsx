import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { cutOutBackground } from "./cutout";
import { mouthOpenness, signals } from "./signals";

export const CAMERA_POSITION = new THREE.Vector3(0, 1.5, 6);
export const CAMERA_FOV = 35;
/** The camera looks slightly down, over the edge of the hill, onto the lake. */
export const CAMERA_PITCH = THREE.MathUtils.degToRad(7);
const PANDA_Z = 1;

// Landmarks in the portrait's UV space (0..1, origin bottom-left).
const NECK = new THREE.Vector2(0.5, 0.3);
const MOUTH = new THREE.Vector2(0.483, 0.405);
const UPPER_LIP_Y = 0.442;
const HEAD_CENTER_Y = 0.6;

const vertexShader = /* glsl */ `
  uniform float uBreath;
  uniform float uSway;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 p = position;
    float fromBottom = p.y + 0.5;
    p.y = fromBottom * (1.0 + uBreath) - 0.5;
    p.x += uSway * fromBottom;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uMouth;
  uniform float uSpeak;
  uniform float uTilt;
  uniform float uNod;
  uniform float uFade;
  uniform vec2 uNeck;
  uniform vec2 uMouthCenter;
  uniform float uUpperLip;
  varying vec2 vUv;

  vec2 rotate(vec2 p, float a) {
    float c = cos(a), s = sin(a);
    return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  }

  void main() {
    vec2 uv = vUv;

    // Head moves on the neck: rotation and nod fade in above the collar.
    float head = smoothstep(uNeck.y - 0.02, uNeck.y + 0.2, uv.y);
    uv = uNeck + rotate(uv - uNeck, -uTilt * head);
    uv.y -= uNod * head;

    // Jaw: pull the area under the upper lip down (open) or up (closed).
    vec2 m = (uv - uMouthCenter) / vec2(0.12, 0.085);
    float jawArea = smoothstep(1.0, 0.25, length(m)) * smoothstep(uUpperLip + 0.01, uUpperLip - 0.012, uv.y);
    uv.y += uSpeak * (uMouth * 0.034 - 0.007) * jawArea;

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
    vec4 color = texture2D(uMap, uv);
    if (color.a < 0.004) discard;

    // Warm rim light where the silhouette faces the sun (upper right).
    float outside = 1.0 - texture2D(uMap, uv + vec2(0.007, 0.006)).a;
    float rim = color.a * outside;
    color.rgb += vec3(1.0, 0.82, 0.55) * rim * 0.55;
    // Settle the studio-lit portrait into the green, hazy forest light.
    color.rgb = mix(color.rgb, color.rgb * vec3(0.93, 1.0, 0.9), 0.35);

    // The bust dissolves into the mist instead of ending on the image's hard edges.
    float bust = smoothstep(0.02, 0.2, vUv.y) * smoothstep(0.0, 0.07, vUv.x) * smoothstep(1.0, 0.93, vUv.x);
    gl_FragColor = vec4(color.rgb, color.a * bust * uFade);
    #include <colorspace_fragment>
  }`;

/** Shared with the motes, which orbit the head while the panda thinks. */
export const pandaHead = new THREE.Vector3(0, 1.6, PANDA_Z);

export function Panda({ src }: { src: string }) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  const mesh = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const { size } = useThree();

  useEffect(() => {
    let cancelled = false;
    cutOutBackground(src)
      .then((canvas) => {
        if (cancelled) return;
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        setTexture(tex);
      })
      .catch((error) => console.error("Could not prepare the panda image", error));
    return () => {
      cancelled = true;
    };
  }, [src]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uMap: { value: null },
          uMouth: { value: 0 },
          uSpeak: { value: 0 },
          uTilt: { value: 0 },
          uNod: { value: 0 },
          uBreath: { value: 0 },
          uSway: { value: 0 },
          uFade: { value: 0 },
          uNeck: { value: NECK },
          uMouthCenter: { value: MOUTH },
          uUpperLip: { value: UPPER_LIP_Y },
        },
        vertexShader,
        fragmentShader,
      }),
    [],
  );

  useEffect(() => {
    material.uniforms.uMap.value = texture;
  }, [material, texture]);

  // Fit the portrait to the screen: the faded shoulders sit behind the controls,
  // the face stays clear above them.
  const layout = useMemo(() => {
    const distance = CAMERA_POSITION.z - PANDA_Z;
    const viewHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2));
    const aspect = size.width / size.height;
    const viewWidth = viewHeight * aspect;
    // The camera looks down a little, so the screen's center sits lower at the panda's depth.
    const centerY = CAMERA_POSITION.y - distance * Math.tan(CAMERA_PITCH);
    let scale: number;
    let y: number;
    if (aspect < 0.85) {
      // Phones: fill the width (the sides fade out) and anchor on the face, above the controls.
      scale = Math.min(viewHeight * 0.8, viewWidth * 1.3);
      y = centerY + viewHeight * 0.08 - (HEAD_CENTER_Y - 0.5) * scale;
    } else {
      // High enough that the mouth stays visible above the subtitles.
      scale = Math.min(viewHeight * 0.7, viewWidth * 0.9);
      y = centerY - viewHeight / 2 + scale / 2 + viewHeight * 0.2;
    }
    pandaHead.set(0, y + (HEAD_CENTER_Y - 0.5) * scale, PANDA_Z);
    return { scale, y };
  }, [size.width, size.height]);

  const motion = useRef({ tilt: 0, nod: 0, mouth: 0, speak: 0, lean: 1, speakingSince: 0, wasSpeaking: false });

  useFrame((state, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    const t = state.clock.elapsedTime;
    const now = performance.now();
    const u = material.uniforms;
    const m = motion.current;
    const phase = signals.phase;

    if (signals.speaking && !m.wasSpeaking) m.speakingSince = t;
    m.wasSpeaking = signals.speaking;

    // Target head pose for each phase.
    let tilt = Math.sin(t * 0.5) * 0.012;
    let lean = 1;
    if (phase === "listening") {
      tilt = 0.06 + Math.sin(t * 1.3) * 0.012 + signals.micLevel * 0.025;
      lean = 1.02;
    } else if (phase === "thinking") {
      tilt = -0.04 + Math.sin(t * 0.9) * 0.02;
    } else if (phase === "speaking") {
      tilt = Math.sin(t * 1.9) * 0.022;
      if (signals.refusing) {
        // Polite "sorry, no" head shake at the start of a refusal.
        const since = t - m.speakingSince;
        tilt += Math.sin(since * 11) * 0.055 * Math.exp(-since * 1.6);
      }
    }

    const ease = (current: number, target: number, rate: number) => current + (target - current) * Math.min(1, delta * rate);
    m.tilt = ease(m.tilt, tilt, 5);
    m.lean = ease(m.lean, lean, 3);
    m.speak = ease(m.speak, signals.speaking ? 1 : 0, 6);
    m.mouth = ease(m.mouth, mouthOpenness(now), 22);
    m.nod = ease(m.nod, signals.speaking ? Math.sin(t * 4.3) * 0.004 * (0.4 + m.mouth) : 0, 8);

    u.uTilt.value = m.tilt;
    u.uMouth.value = m.mouth;
    u.uSpeak.value = m.speak;
    u.uNod.value = m.nod;
    u.uBreath.value = Math.sin(t * 1.55) * 0.0045;
    u.uSway.value = Math.sin(t * 0.62) * 0.004;
    if (texture) u.uFade.value = ease(u.uFade.value, 1, 2);

    if (mesh.current) {
      mesh.current.scale.setScalar(layout.scale * m.lean);
      mesh.current.position.y = layout.y - (layout.scale * (m.lean - 1)) / 2;
    }
    if (halo.current) {
      const glow = halo.current.material as THREE.MeshBasicMaterial;
      glow.opacity = (0.3 + (phase === "listening" ? signals.micLevel * 0.35 : 0) + (phase === "thinking" ? 0.12 : 0)) * u.uFade.value;
    }
  });

  return (
    <group>
      {/* A soft light behind the head separates the character from the forest. */}
      <mesh ref={halo} position={[0, pandaHead.y, PANDA_Z - 1.5]} rotation-x={-CAMERA_PITCH} scale={layout.scale * 1.7}>
        <planeGeometry />
        <meshBasicMaterial map={haloTexture()} transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={0} toneMapped={false} />
      </mesh>
      {/* Tilted to face the camera, so the portrait isn't foreshortened. */}
      <mesh ref={mesh} position={[0, layout.y, PANDA_Z]} rotation-x={-CAMERA_PITCH} material={material} renderOrder={10}>
        <planeGeometry />
      </mesh>
    </group>
  );
}

let cachedHalo: THREE.Texture | null = null;
function haloTexture(): THREE.Texture {
  if (cachedHalo) return cachedHalo;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, "rgba(255, 236, 190, 0.9)");
  gradient.addColorStop(0.45, "rgba(255, 226, 170, 0.28)");
  gradient.addColorStop(1, "rgba(255, 220, 160, 0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  cachedHalo = new THREE.CanvasTexture(canvas);
  cachedHalo.colorSpace = THREE.SRGBColorSpace;
  return cachedHalo;
}
