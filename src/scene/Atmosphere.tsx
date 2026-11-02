import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { signals } from "../avatar/signals";
import { HAZE, SKY_HIGH, SUN_DIRECTION } from "./environment";
import { seededRandom, windUniforms } from "./wind";

/** Gradient sky dome: hazy at the horizon, a low warm sun over the lake. */
export function Sky() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { uSun: { value: SUN_DIRECTION }, uHaze: { value: HAZE }, uHigh: { value: SKY_HIGH } },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uSun, uHaze, uHigh;
          varying vec3 vDir;
          void main() {
            float y = vDir.y;
            vec3 color = mix(uHaze, uHigh, smoothstep(0.0, 0.75, max(y, 0.0)));
            float sun = max(dot(vDir, uSun), 0.0);
            color += vec3(1.0, 0.85, 0.6) * (pow(sun, 6.0) * 0.35 + pow(sun, 90.0) * 0.5);
            // The sun's disc, bright enough to bloom softly.
            color += vec3(1.0, 0.93, 0.8) * smoothstep(0.9993, 0.9997, sun) * 1.6;
            gl_FragColor = vec4(color, 1.0);
            #include <colorspace_fragment>
          }`,
      }),
    [],
  );
  return (
    <mesh material={material} renderOrder={-1}>
      <sphereGeometry args={[400, 48, 24]} />
    </mesh>
  );
}

/** Soft beams of sunlight slanting through the side groves, slowly breathing. */
export function LightShafts() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: { uTime: windUniforms.uTime },
        vertexShader: /* glsl */ `
          attribute float aSeed;
          varying vec2 vUv;
          varying float vSeed;
          void main() {
            vUv = uv;
            vSeed = aSeed;
            gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          varying vec2 vUv;
          varying float vSeed;
          void main() {
            float edge = smoothstep(0.0, 0.45, vUv.x) * smoothstep(1.0, 0.55, vUv.x);
            float fade = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
            float pulse = 0.55 + 0.45 * sin(uTime * 0.35 + vSeed * 6.28);
            float alpha = edge * fade * pulse * 0.13;
            gl_FragColor = vec4(vec3(1.0, 0.9, 0.68) * alpha, alpha);
          }`,
      }),
    [],
  );

  const mesh = useMemo(() => {
    const random = seededRandom(3);
    const count = 6;
    const geometry = new THREE.PlaneGeometry(1, 1);
    const seeds = new Float32Array(count).map(() => random());
    geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
    const instanced = new THREE.InstancedMesh(geometry, material, count);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const width = 0.6 + random() * 1.4;
      // Inside the groves on either side, not over the open view.
      const side = i % 2 ? 1 : -1;
      matrix.compose(
        new THREE.Vector3(side * (3.5 + random() * 3.5), 5, -3 - random() * 6),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -0.42 + (random() - 0.5) * 0.1)),
        new THREE.Vector3(width, 13, 1),
      );
      instanced.setMatrixAt(i, matrix);
    }
    instanced.frustumCulled = false;
    return instanced;
  }, [material]);

  return <primitive object={mesh} />;
}

/**
 * Floating pollen in the air. Drifts with the wind, glows brighter when the user
 * speaks, and gathers into a slow swirl around the panda's head while it thinks.
 */
export function Motes({ focus }: { focus: THREE.Vector3 }) {
  const count = 420;
  const { geometry, material } = useMemo(() => {
    const random = seededRandom(11);
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions.set([(random() - 0.5) * 14, random() * 6, 3 - random() * 14], i * 3);
      seeds[i] = random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: windUniforms.uTime,
        uWind: windUniforms.uWind,
        uThink: { value: 0 },
        uGlow: { value: 0 },
        uFocus: { value: focus },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      vertexShader: /* glsl */ `
        uniform float uTime, uWind, uThink, uPixelRatio;
        uniform vec3 uFocus;
        attribute float aSeed;
        varying float vTwinkle;
        void main() {
          vec3 p = position;
          float t = uTime * (0.15 + aSeed * 0.2);
          p.x += sin(t + aSeed * 40.0) * 0.6 + uTime * 0.08 * uWind;
          p.y += sin(t * 1.3 + aSeed * 17.0) * 0.4;
          p.z += cos(t * 0.9 + aSeed * 23.0) * 0.5;
          p.x = mod(p.x + 7.0, 14.0) - 7.0;
          // Thinking: a share of the motes orbit the panda's head.
          float angle = uTime * (0.6 + aSeed * 0.5) + aSeed * 6.2831;
          float radius = 0.75 + aSeed * 0.55;
          vec3 orbit = uFocus + vec3(cos(angle) * radius, sin(angle * 0.7 + aSeed * 3.0) * 0.35 + 0.25, sin(angle) * radius * 0.5);
          p = mix(p, orbit, uThink * step(aSeed, 0.28));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (2.0 + aSeed * 4.0) * uPixelRatio * (12.0 / -mv.z);
          vTwinkle = 0.55 + 0.45 * sin(uTime * (1.5 + aSeed * 3.0) + aSeed * 50.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uGlow, uThink;
        varying float vTwinkle;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float alpha = smoothstep(0.5, 0.0, d) * vTwinkle * (0.35 + uGlow * 0.5 + uThink * 0.3);
          gl_FragColor = vec4(vec3(1.0, 0.93, 0.7) * alpha, alpha);
        }`,
    });
    return { geometry: geo, material: mat };
  }, [focus]);

  useFrame((_, delta) => {
    const u = material.uniforms;
    const thinking = signals.phase === "thinking" ? 1 : 0;
    u.uThink.value += (thinking - u.uThink.value) * Math.min(1, delta * 2.2);
    u.uGlow.value = signals.phase === "listening" ? signals.micLevel : u.uGlow.value * 0.95;
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
}
