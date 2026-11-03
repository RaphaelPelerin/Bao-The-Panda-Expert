import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { memo, useMemo, useRef } from "react";
import * as THREE from "three";
import { CAMERA_FOV, CAMERA_PITCH, CAMERA_POSITION, Panda, pandaHead } from "../avatar/Panda";
import { signals } from "../avatar/signals";
import { LightShafts, Motes, Sky } from "./Atmosphere";
import { BambooLayers } from "./BambooLayers";
import { HAZE } from "./environment";
import { FallingLeaves } from "./FallingLeaves";
import { Vista } from "./Vista";
import { windUniforms } from "./wind";

/** Highest render scale; the adaptive loop below only ever lowers it from here. */
const MAX_DPR = Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio, 1.5);
const MIN_DPR = 0.6;

/** Advances the shared wind clock; the user's voice stirs up a gust. */
function WindDriver() {
  useFrame((_, delta) => {
    windUniforms.uTime.value += Math.min(delta, 0.05);
    const target = 1 + (signals.phase === "listening" ? signals.micLevel * 1.6 : 0);
    windUniforms.uWind.value += (target - windUniforms.uWind.value) * Math.min(1, delta * 1.5);
  });
  return null;
}

/** Gentle handheld drift plus parallax that follows the pointer. */
function CameraRig() {
  const lookAt = useMemo(() => new THREE.Vector3(), []);
  const target = useMemo(() => new THREE.Vector3(), []);
  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    target.set(
      CAMERA_POSITION.x + state.pointer.x * 0.28 + Math.sin(t * 0.21) * 0.05,
      CAMERA_POSITION.y + state.pointer.y * 0.1 + Math.sin(t * 0.17) * 0.03,
      CAMERA_POSITION.z,
    );
    state.camera.position.lerp(target, Math.min(1, delta * 1.8));
    // Ten units ahead, lowered by the pitch: the view dips toward the lake.
    lookAt.set(state.camera.position.x * 0.45, CAMERA_POSITION.y - 10 * Math.tan(CAMERA_PITCH), -4);
    state.camera.lookAt(lookAt);
  });
  return null;
}

/**
 * Keeps the frame rate smooth on weaker machines: lowers the render resolution
 * when the scene runs under ~45 fps twice in a row. It never raises it again:
 * each change resizes every render target, which can flash, so going back and
 * forth every few seconds is worse than a slightly softer picture. Also
 * publishes the measured fps for the debug panel.
 */
function AdaptiveResolution() {
  const setDpr = useThree((state) => state.setDpr);
  const sample = useRef({ frames: 0, time: 0, slow: 0, dpr: MAX_DPR });
  useFrame((_, delta) => {
    const s = sample.current;
    s.frames++;
    s.time += delta;
    if (s.time < 2) return;
    const fps = s.frames / s.time;
    signals.fps = Math.round(fps);
    s.slow = fps < 45 ? s.slow + 1 : 0;
    if (s.slow >= 2 && s.dpr > MIN_DPR) {
      s.dpr = Math.max(MIN_DPR, s.dpr - 0.25);
      s.slow = 0;
      setDpr(s.dpr);
    }
    signals.renderScale = s.dpr;
    s.frames = 0;
    s.time = 0;
  });
  return null;
}

/**
 * Memoized: the UI re-renders on every streamed word, and the 3D scene must
 * not be reconciled each time. Everything it animates comes from `signals`.
 */
export const Scene = memo(function Scene() {
  return (
    <Canvas
      dpr={MAX_DPR}
      gl={{ antialias: false, powerPreference: "high-performance", stencil: false, depth: true }}
      camera={{ position: CAMERA_POSITION.toArray(), fov: CAMERA_FOV, near: 0.1, far: 700 }}
    >
      {/* Exponential haze: the groves stay crisp, the lake and mountains fade into the distance. */}
      <fogExp2 attach="fog" args={[HAZE, 0.011]} />
      <hemisphereLight args={["#eef6d8", "#2f4a26", 1.1]} />
      <directionalLight position={[7, 11, -9]} intensity={2.6} color="#ffe0ad" />
      <directionalLight position={[-4, 3, 6]} intensity={0.55} color="#cfe6ff" />

      <WindDriver />
      <CameraRig />
      <AdaptiveResolution />
      <Sky />
      <Vista />
      <BambooLayers />
      <LightShafts />
      <Motes focus={pandaHead} />
      <FallingLeaves />
      <Panda />

      {/* No MSAA: it was the most expensive part of the frame, and the soft,
          hazy look hides aliasing. Bloom runs at half resolution. */}
      <EffectComposer multisampling={0}>
        {/* High threshold: only sun glints and pollen glow. A lower one blooms the pale
            sky between stalks, which bleeds over the panda as vertical bands. */}
        <Bloom mipmapBlur intensity={0.5} luminanceThreshold={0.96} luminanceSmoothing={0.08} resolutionScale={0.5} />
        <ToneMapping mode={ToneMappingMode.NEUTRAL} />
        <Vignette offset={0.28} darkness={0.55} />
        <Noise opacity={0.028} premultiply />
      </EffectComposer>
    </Canvas>
  );
});
