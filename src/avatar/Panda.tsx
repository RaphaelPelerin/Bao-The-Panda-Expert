import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { cutOutBackground } from "./cutout";
import { lipSync } from "./lipsync";
import { MouthAtlas, type MouthCell } from "./mouthAtlas";
import { mouthOpenness, signals } from "./signals";
import { VideoLoop } from "./videoLoop";

export const CAMERA_POSITION = new THREE.Vector3(0, 1.5, 6);
export const CAMERA_FOV = 35;
/** The camera looks slightly down, over the edge of the hill, onto the lake. */
export const CAMERA_PITCH = THREE.MathUtils.degToRad(7);
const PANDA_Z = 1;

/** Where the face sits in a source, in UV space (0..1, origin bottom-left). */
interface Landmarks {
  neck: THREE.Vector2;
  mouth: THREE.Vector2;
  upperLip: number;
  headCenterY: number;
}

/**
 * The AI-generated idle clip on a blue screen: breathes and blinks by itself.
 * Baked into a seamless loop from raw/: the brighter opening frames are cut, and
 * a quarter-second cross-fade joins the end to the start where the eyes are
 * open on both sides, so the slow blink never blends into a double image.
 */
const VIDEO = {
  url: "/videos/bao-idle.mp4",
  landmarks: {
    neck: new THREE.Vector2(0.5, 0.27),
    mouth: new THREE.Vector2(0.5, 0.325),
    upperLip: 0.35,
    headCenterY: 0.53,
  } satisfies Landmarks,
};

/**
 * The talk clip, looped forward then backward by scripts/make-loop.ts (its head
 * never returns to the same place, so a cross-faded join would ghost). Shown
 * while the panda speaks, with the lip-synced mouth pasted over its own.
 */
const TALK_VIDEO_URL = "/videos/bao-talk.mp4";
/**
 * The think clip, also ping-ponged. Shown while the model is generating an
 * answer, between listening and speaking.
 */
const THINK_VIDEO_URL = "/videos/bao-think.mp4";
/** Seconds to cross-fade between the idle, think and talk loops. */
const TALK_FADE = 0.25;

/** Fallback when the clip cannot play: the original portrait, cut out on the CPU. */
const IMAGE = {
  url: "/assets/panda.jpg",
  landmarks: {
    neck: new THREE.Vector2(0.5, 0.3),
    mouth: new THREE.Vector2(0.483, 0.405),
    upperLip: 0.442,
    headCenterY: 0.6,
  } satisfies Landmarks,
};

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
  // The think loop, cross-faded over the idle loop while the model answers.
  uniform sampler2D uThinkMap;
  uniform float uThinkMix;
  // The talk loop, cross-faded over the idle (or think) loop while the panda speaks.
  uniform sampler2D uTalkMap;
  uniform float uTalkMix;
  uniform float uChroma;
  uniform float uJaw;
  uniform float uMouth;
  uniform float uSpeak;
  uniform float uTilt;
  uniform float uNod;
  uniform float uFade;
  uniform vec2 uNeck;
  uniform vec2 uMouthCenter;
  uniform float uUpperLip;
  // Lip sync: real mouths from the talk clip, pasted where the mouth sits on the live frame.
  uniform sampler2D uLipAtlas;
  uniform float uLipOn;
  uniform vec4 uLipPatch;   // Patch on the idle video, from the top-left: x, y, width, height.
  uniform vec4 uLipPatchTalk; // Same, on the talk video, whose head moves more.
  uniform vec2 uLipGrid;    // Atlas columns, rows.
  uniform vec2 uLipCellA;
  uniform vec2 uLipCellB;
  uniform vec3 uLipGainA;
  uniform vec3 uLipGainB;
  uniform float uLipMix;    // 0 shows cell A, 1 cell B.
  uniform sampler2D uLipMask; // Over the patch: where the pasted mouth shows (the white fur around nose and mouth).
  varying vec2 vUv;

  vec2 rotate(vec2 p, float a) {
    float c = cos(a), s = sin(a);
    return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  }

  vec3 lipCell(vec2 cell, vec2 local) {
    vec2 p = (cell + local) / uLipGrid;
    return texture2D(uLipAtlas, vec2(p.x, 1.0 - p.y)).rgb;
  }

  // Pastes the lip-synced mouth onto one video frame, at that frame's mouth.
  vec3 withMouth(vec3 color, vec2 uv, vec4 area) {
    vec2 local = (vec2(uv.x, 1.0 - uv.y) - area.xy) / area.zw;
    if (local.x <= 0.0 || local.x >= 1.0 || local.y <= 0.0 || local.y >= 1.0) return color;
    float mask = texture2D(uLipMask, vec2(local.x, 1.0 - local.y)).r * uLipOn;
    vec3 mouth = mix(lipCell(uLipCellA, local) * uLipGainA, lipCell(uLipCellB, local) * uLipGainB, uLipMix);
    return mix(color, mouth, mask);
  }

  // One avatar pixel: for video, keys out the blue screen and removes the
  // blue that bleeds into the fur's edges.
  vec4 avatar(vec2 uv) {
    vec4 color = texture2D(uMap, uv);
    if (uLipOn > 0.0) color.rgb = withMouth(color.rgb, uv, uLipPatch);
    // Think has its own closed mouth; no lip paste. Talk wins when both mix.
    if (uThinkMix > 0.0) color = mix(color, texture2D(uThinkMap, uv), uThinkMix);
    if (uTalkMix > 0.0) {
      vec4 talk = texture2D(uTalkMap, uv);
      if (uLipOn > 0.0) talk.rgb = withMouth(talk.rgb, uv, uLipPatchTalk);
      color = mix(color, talk, uTalkMix);
    }
    if (uChroma > 0.5) {
      float key = color.b - max(color.r, color.g);
      color.a = 1.0 - smoothstep(0.06, 0.22, key);
      color.b = min(color.b, max(color.r, color.g) * 1.04 + 0.01);
    }
    return color;
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
    uv.y += uSpeak * uJaw * (uMouth * 0.034 - 0.007) * jawArea;

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
    vec4 color = avatar(uv);
    if (color.a < 0.004) discard;

    // Warm rim light where the silhouette faces the sun (upper right).
    float outside = 1.0 - avatar(uv + vec2(0.007, 0.006)).a;
    float rim = color.a * outside;
    color.rgb += vec3(1.0, 0.82, 0.55) * rim * 0.55;

    // The bust fades out instead of ending on the image's hard edges.
    float bust = smoothstep(0.02, 0.2, vUv.y) * smoothstep(0.0, 0.07, vUv.x) * smoothstep(1.0, 0.93, vUv.x);
    gl_FragColor = vec4(color.rgb, color.a * bust * uFade);
  }`;

/** Shared with the motes, which orbit the head while the panda thinks. */
export const pandaHead = new THREE.Vector3(0, 1.6, PANDA_Z);

type Source = { kind: "video"; loop: VideoLoop } | { kind: "image"; texture: THREE.Texture };

export function Panda() {
  const [source, setSource] = useState<Source | null>(null);
  const mesh = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const { size } = useThree();

  // The video shows as soon as it is loaded: paused on the loop's first frame,
  // then animated once playback starts (on the first tap if autoplay is blocked).
  // The still portrait is only used when the clip cannot load at all.
  useEffect(() => {
    let cancelled = false;
    const loop = new VideoLoop(VIDEO.url);
    const retryOnTap = () => {
      window.removeEventListener("pointerdown", retryOnTap);
      loop.start().catch((error) => console.warn("Avatar video still blocked:", error));
    };

    loop.loaded
      .then(() => {
        if (cancelled) return;
        setSource({ kind: "video", loop });
        loop.start().catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "NotAllowedError") window.addEventListener("pointerdown", retryOnTap);
          else console.warn("Avatar video could not start:", error);
        });
      })
      .catch(async (error) => {
        console.warn("Avatar video unavailable, using the still portrait:", error);
        const canvas = await cutOutBackground(IMAGE.url);
        if (cancelled) return;
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 8;
        setSource({ kind: "image", texture });
      });

    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", retryOnTap);
      loop.dispose();
    };
  }, []);

  // Optional: without them the panda stays on the idle loop for think / talk.
  const [talk, setTalk] = useState<VideoLoop | null>(null);
  const [think, setThink] = useState<VideoLoop | null>(null);
  useEffect(() => {
    let cancelled = false;
    const start = (url: string, label: string, set: (loop: VideoLoop) => void) => {
      const loop = new VideoLoop(url);
      const retryOnTap = () => {
        window.removeEventListener("pointerdown", retryOnTap);
        loop.start().catch((error) => console.warn(`${label} video still blocked:`, error));
      };
      loop.loaded
        .then(() => {
          if (cancelled) {
            loop.dispose();
            return;
          }
          set(loop);
          // Always playing, so its texture is live the moment that phase starts.
          loop.start().catch((error: unknown) => {
            if (error instanceof DOMException && error.name === "NotAllowedError") window.addEventListener("pointerdown", retryOnTap);
          });
        })
        .catch((error) => console.warn(`${label} video unavailable, staying on the idle loop:`, error));
      return () => {
        window.removeEventListener("pointerdown", retryOnTap);
        loop.dispose();
      };
    };
    const stopTalk = start(TALK_VIDEO_URL, "Talk", setTalk);
    const stopThink = start(THINK_VIDEO_URL, "Think", setThink);
    return () => {
      cancelled = true;
      stopTalk();
      stopThink();
    };
  }, []);

  // Optional: without the lip-sync assets the panda talks with the jaw warp only.
  const [atlas, setAtlas] = useState<MouthAtlas | null>(null);
  useEffect(() => {
    let cancelled = false;
    MouthAtlas.load()
      .then((loaded) => !cancelled && setAtlas(loaded))
      .catch((error) => console.warn("Lip sync unavailable:", error));
    return () => {
      cancelled = true;
    };
  }, []);

  const landmarks = source?.kind === "image" ? IMAGE.landmarks : VIDEO.landmarks;

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uMap: { value: null },
          uThinkMap: { value: null },
          uThinkMix: { value: 0 },
          uTalkMap: { value: null },
          uTalkMix: { value: 0 },
          uChroma: { value: 0 },
          uJaw: { value: 1 },
          uMouth: { value: 0 },
          uSpeak: { value: 0 },
          uTilt: { value: 0 },
          uNod: { value: 0 },
          uBreath: { value: 0 },
          uSway: { value: 0 },
          uFade: { value: 0 },
          uNeck: { value: VIDEO.landmarks.neck },
          uMouthCenter: { value: VIDEO.landmarks.mouth },
          uUpperLip: { value: VIDEO.landmarks.upperLip },
          uLipAtlas: { value: null },
          uLipOn: { value: 0 },
          uLipPatch: { value: new THREE.Vector4() },
          uLipPatchTalk: { value: new THREE.Vector4() },
          uLipGrid: { value: new THREE.Vector2(1, 1) },
          uLipCellA: { value: new THREE.Vector2() },
          uLipCellB: { value: new THREE.Vector2() },
          uLipGainA: { value: new THREE.Vector3(1, 1, 1) },
          uLipGainB: { value: new THREE.Vector3(1, 1, 1) },
          uLipMix: { value: 0 },
          uLipMask: { value: null },
        },
        vertexShader,
        fragmentShader,
      }),
    [],
  );

  useEffect(() => {
    const u = material.uniforms;
    u.uNeck.value = landmarks.neck;
    u.uMouthCenter.value = landmarks.mouth;
    u.uUpperLip.value = landmarks.upperLip;
    if (source?.kind === "image") {
      u.uMap.value = source.texture;
      u.uChroma.value = 0;
      u.uJaw.value = 1;
    } else if (source?.kind === "video") {
      u.uMap.value = source.loop.texture;
      u.uChroma.value = 1;
      // Real mouths replace the jaw warp; without the atlas, a small warp still reads as talking.
      u.uJaw.value = atlas ? 0 : 0.55;
    }
  }, [material, source, landmarks, atlas]);

  useEffect(() => {
    if (!atlas) return;
    const u = material.uniforms;
    u.uLipAtlas.value = atlas.texture;
    u.uLipGrid.value = atlas.grid;
    u.uLipMask.value = atlas.mask;
  }, [material, atlas]);

  // Fit the portrait to the screen: the faded shoulders sit behind the controls,
  // the face stays clear above them.
  const layout = useMemo(() => {
    const distance = CAMERA_POSITION.z - PANDA_Z;
    const viewHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2));
    const aspect = size.width / size.height;
    const viewWidth = viewHeight * aspect;
    // The camera looks down a little, so the screen's center sits lower at the panda's depth.
    const centerY = CAMERA_POSITION.y - distance * Math.tan(CAMERA_PITCH);
    // Place the head at a fixed spot on screen, whatever the source's framing.
    let scale: number;
    let headY: number;
    if (aspect < 0.85) {
      // Phones: fill the width (the sides fade out), face above the controls.
      scale = Math.min(viewHeight * 0.8, viewWidth * 1.3);
      headY = centerY + viewHeight * 0.08;
    } else {
      // High enough that the mouth stays visible above the subtitles.
      scale = Math.min(viewHeight * 0.7, viewWidth * 0.9);
      headY = centerY - viewHeight / 2 + scale * 0.6 + viewHeight * 0.2;
    }
    const y = headY - (landmarks.headCenterY - 0.5) * scale;
    pandaHead.set(0, headY, PANDA_Z);
    return { scale, y };
  }, [size.width, size.height, landmarks]);

  const motion = useRef({ tilt: 0, nod: 0, mouth: 0, speak: 0, lean: 1, speakingSince: 0, wasSpeaking: false });
  const lip = useRef<{ open: number; wide: number; from: MouthCell | null; to: MouthCell | null; mix: number }>({
    open: 0,
    wide: 0.5,
    from: null,
    to: null,
    mix: 1,
  });
  /**
   * Which loop is (or is fading to) on screen, when that fade started, and when
   * the hidden loop was last moved to open eyes (clock seconds).
   */
  const talkSwitch = useRef<{ talking: boolean; since: number | null; seekedAt: number | null }>({
    talking: false,
    since: null,
    seekedAt: null,
  });

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

    if (source?.kind === "video" && atlas) {
      const l = lip.current;
      const shape = lipSync.sample(now);
      l.open = ease(l.open, shape.open, 30);
      l.wide = ease(l.wide, shape.wide, 30);
      const cell = atlas.pick(l.open, l.wide);
      if (cell !== l.to) {
        l.from = l.to ?? cell;
        l.to = cell;
        l.mix = 0;
      }
      // Mouths cut rather than morph, like drawn animation; a very short blend hides the pop.
      l.mix = Math.min(1, l.mix + delta / 0.045);
      u.uLipCellA.value = l.from!.cell;
      u.uLipGainA.value = l.from!.gain;
      u.uLipCellB.value = cell.cell;
      u.uLipGainB.value = cell.gain;
      u.uLipMix.value = l.mix;
      atlas.patchAt(source.loop.mediaTime, u.uLipPatch.value);

      // Think loop: shown while waiting for the answer. No eye gating (no track), short fade.
      u.uThinkMap.value = think?.texture ?? null;
      // ~TALK_FADE seconds to settle (exponential ease needs ~3/rate).
      u.uThinkMix.value = think ? ease(u.uThinkMix.value, phase === "thinking" ? 1 : 0, 3 / TALK_FADE) : 0;

      // The talk loop's own mouth moves at random, so it is only shown with a pasted mouth.
      const canTalk = !!talk && atlas.hasTalkLoop;
      u.uTalkMap.value = canTalk ? talk.texture : null;
      if (canTalk) {
        const sw = talkSwitch.current;
        // Switch only while the eyes stay open on both loops for the whole fade,
        // so a blink never cross-fades into open eyes. The loop on screen is
        // waited for; the hidden one is moved to frames with open eyes. Waiting
        // costs little: the lip-synced mouth already works on either loop.
        const span = TALK_FADE + 0.1;
        if (sw.since === null && signals.speaking !== sw.talking) {
          const [shown, hidden] = sw.talking ? (["talk", "idle"] as const) : (["idle", "talk"] as const);
          const shownLoop = sw.talking ? talk : source.loop;
          const hiddenLoop = sw.talking ? source.loop : talk;
          if (atlas.eyesOpen(shown, shownLoop.mediaTime, span)) {
            if (atlas.eyesOpen(hidden, hiddenLoop.mediaTime, span)) {
              sw.talking = signals.speaking;
              sw.since = t;
              sw.seekedAt = null;
            } else if (sw.seekedAt === null || t - sw.seekedAt > 0.5) {
              // A margin for the seek to land before the window starts.
              const target = atlas.nextOpen(hidden, hiddenLoop.mediaTime, span + 0.4);
              if (target !== null) hiddenLoop.seek(target);
              sw.seekedAt = t;
            }
          }
        }
        const p = sw.since === null ? 1 : Math.min(1, (t - sw.since) / TALK_FADE);
        if (p >= 1) sw.since = null;
        const s = p * p * (3 - 2 * p);
        u.uTalkMix.value = sw.talking ? s : 1 - s;
        atlas.patchAt(talk.mediaTime, u.uLipPatchTalk.value, "talk");
      } else {
        u.uTalkMix.value = 0;
      }
      // Between sentences the voice pauses, but the talk loop still shows: keep its mouth covered (closed).
      u.uLipOn.value = ease(u.uLipOn.value, Math.max(shape.active, u.uTalkMix.value > 0.01 ? 1 : 0), 25);
    } else {
      u.uLipOn.value = 0;
      u.uTalkMix.value = 0;
      u.uThinkMap.value = think?.texture ?? null;
      u.uThinkMix.value = think ? ease(u.uThinkMix.value, phase === "thinking" ? 1 : 0, 3 / TALK_FADE) : 0;
    }

    u.uTilt.value = m.tilt;
    u.uMouth.value = m.mouth;
    u.uSpeak.value = m.speak;
    // Think and talk loops already animate the head.
    u.uNod.value = m.nod * (1 - Math.max(u.uTalkMix.value, u.uThinkMix.value));
    // The video already breathes; the still portrait needs a little help.
    u.uBreath.value = source?.kind === "image" ? Math.sin(t * 1.55) * 0.0045 : 0;
    u.uSway.value = Math.sin(t * 0.62) * 0.004;
    if (source) u.uFade.value = ease(u.uFade.value, 1, 2);

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
      {/* A soft light behind the head separates the character from the background. */}
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
