import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { memo, useLayoutEffect, useRef } from "react";
import { CAMERA_FOV, CAMERA_PITCH, CAMERA_POSITION, Panda } from "../avatar/Panda";
import { signals } from "../avatar/signals";

/** Highest render scale; the adaptive loop below only ever lowers it from here. */
const MAX_DPR = Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio, 1.5);
const MIN_DPR = 0.6;

/** Points the fixed camera at the panda, looking down a little. */
function CameraAim() {
  const camera = useThree((state) => state.camera);
  useLayoutEffect(() => {
    camera.lookAt(0, CAMERA_POSITION.y - 10 * Math.tan(CAMERA_PITCH), -4);
  }, [camera]);
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
 * Only the panda, on a transparent canvas over public/background.png
 * (side bamboo is a separate DOM overlay). Memoized: the UI re-renders on
 * every streamed word, and the 3D scene must not be reconciled each time.
 */
export const Scene = memo(function Scene() {
  return (
    <Canvas
      dpr={MAX_DPR}
      gl={{ alpha: true, antialias: false, powerPreference: "high-performance", stencil: false, depth: true }}
      camera={{ position: CAMERA_POSITION.toArray(), fov: CAMERA_FOV, near: 0.1, far: 100 }}
    >
      <CameraAim />
      <AdaptiveResolution />
      <Panda />
    </Canvas>
  );
});
