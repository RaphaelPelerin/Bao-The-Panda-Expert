import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { useMemo } from "react";
import * as THREE from "three";
import { CAMERA_FOV, CAMERA_PITCH, CAMERA_POSITION, Panda, pandaHead } from "../avatar/Panda";
import { signals } from "../avatar/signals";
import { LightShafts, Motes, Sky } from "./Atmosphere";
import { BambooGroup, forestLayout, makeStalk } from "./Bamboo";
import { HAZE } from "./environment";
import { FallingLeaves } from "./FallingLeaves";
import { Vista } from "./Vista";
import { seededRandom, windUniforms } from "./wind";

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
  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const target = new THREE.Vector3(
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

/** Big, close stalks framing the panda on wide screens. Hidden on narrow ones. */
function ForegroundBamboo() {
  const { size } = useThree();
  const aspect = size.width / size.height;
  const stalks = useMemo(() => {
    if (aspect < 1.15) return [];
    const random = seededRandom(5);
    const z = 3.3;
    const viewHalfWidth = (CAMERA_POSITION.z - z) * Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2)) * aspect;
    // Half off-screen at the very edges, so they frame the view without hiding it.
    return [makeStalk(random, -viewHalfWidth * 0.97, z, true), makeStalk(random, viewHalfWidth * 1.0, z - 0.3, true)].map(
      // Few leaves up close: they read as big blurry shapes and hide the panda.
      (stalk) => ({ ...stalk, leaves: 8, radius: stalk.radius * 0.8 }),
    );
  }, [aspect]);
  if (!stalks.length) return null;
  return <BambooGroup key={aspect.toFixed(2)} stalks={stalks} seed={31} />;
}

/** The two side groves, re-laid out when the screen shape changes noticeably. */
function Groves() {
  const { size } = useThree();
  const aspect = Math.round((size.width / size.height) * 10) / 10;
  const stalks = useMemo(() => forestLayout(aspect, CAMERA_POSITION.z, CAMERA_FOV), [aspect]);
  return <BambooGroup key={aspect} stalks={stalks} seed={13} />;
}

export function Scene() {
  return (
    <Canvas
      dpr={[1, 1.75]}
      gl={{ antialias: false, powerPreference: "high-performance", stencil: false }}
      camera={{ position: CAMERA_POSITION.toArray(), fov: CAMERA_FOV, near: 0.1, far: 700 }}
    >
      {/* Exponential haze: the groves stay crisp, the lake and mountains fade into the distance. */}
      <fogExp2 attach="fog" args={[HAZE, 0.011]} />
      <hemisphereLight args={["#eef6d8", "#2f4a26", 1.1]} />
      <directionalLight position={[7, 11, -9]} intensity={2.6} color="#ffe0ad" />
      <directionalLight position={[-4, 3, 6]} intensity={0.55} color="#cfe6ff" />

      <WindDriver />
      <CameraRig />
      <Sky />
      <Vista />
      <Groves />
      <LightShafts />
      <Motes focus={pandaHead} />
      <FallingLeaves />
      <Panda src="/assets/panda.jpg" />
      <ForegroundBamboo />

      <EffectComposer multisampling={4}>
        {/* High threshold: only sun glints and pollen glow. A lower one blooms the pale
            sky between stalks, which bleeds over the panda as vertical bands. */}
        <Bloom mipmapBlur intensity={0.5} luminanceThreshold={0.96} luminanceSmoothing={0.08} />
        <ToneMapping mode={ToneMappingMode.NEUTRAL} />
        <Vignette offset={0.28} darkness={0.55} />
        <Noise opacity={0.028} premultiply />
      </EffectComposer>
    </Canvas>
  );
}
