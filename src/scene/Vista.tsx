import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { HAZE, HILLTOP_Y, SKY_HIGH, SUN_DIRECTION, WATER_Y, groundHeight } from "./environment";
import { seededRandom, windUniforms } from "./wind";

// The view past the bamboo: the hilltop drops to a lake with a small village on
// its shore, a pagoda, a boat, and layers of karst mountains in the mist.
// Mountains and village are drawn a second time upside down under the water,
// seen through the semi-transparent lake: cheap reflections without a second render pass.

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

// ---------- terrain ----------

/** The hilltop under the bamboo, its slope down to the shore, and the valley floor below the water. */
function Terrain() {
  const geometry = useMemo(() => {
    const plane = new THREE.PlaneGeometry(220, 42, 220, 84);
    plane.rotateX(-Math.PI / 2);
    plane.translate(0, 0, -13);
    const position = plane.attributes.position;
    const colors = new Float32Array(position.count * 3);
    const grass = new THREE.Color("#5c7b3d");
    const slopeGreen = new THREE.Color("#46663a");
    const shore = new THREE.Color("#7f8c5c");
    const color = new THREE.Color();
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const z = position.getZ(i);
      const y = groundHeight(x, z);
      position.setY(i, y);
      color.copy(grass).lerp(slopeGreen, smoothstep(HILLTOP_Y, WATER_Y, y));
      if (y < WATER_Y + 0.8) color.lerp(shore, 0.6);
      colors.set([color.r, color.g, color.b], i * 3);
    }
    plane.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    plane.computeVertexNormals();
    return plane;
  }, []);

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial vertexColors roughness={1} />
    </mesh>
  );
}

// ---------- lake ----------

function Lake() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        uniforms: {
          uTime: windUniforms.uTime,
          uSun: { value: SUN_DIRECTION },
          uHaze: { value: HAZE },
          uSkyHigh: { value: SKY_HIGH },
          uDeep: { value: new THREE.Color("#2f5550") },
        },
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          void main() {
            vec4 world = modelMatrix * vec4(position, 1.0);
            vWorld = world.xyz;
            gl_Position = projectionMatrix * viewMatrix * world;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform vec3 uSun, uHaze, uSkyHigh, uDeep;
          varying vec3 vWorld;
          void main() {
            vec3 toCamera = cameraPosition - vWorld;
            float dist = length(toCamera);
            vec3 view = toCamera / dist;

            // Small wind ripples, flattened with distance to avoid shimmering.
            vec2 p = vWorld.xz;
            float detail = 1.0 / (1.0 + dist * 0.035);
            vec2 slope = vec2(cos(p.x * 0.9 + uTime * 0.8), cos(p.y * 1.3 - uTime * 0.6)) * 0.07
                       + vec2(cos(p.x * 2.3 - p.y * 1.1 + uTime * 1.7), cos(p.y * 2.9 + p.x * 0.7 + uTime * 1.3)) * 0.035;
            vec3 normal = normalize(vec3(-slope.x * detail, 1.0, -slope.y * detail));

            vec3 reflected = reflect(-view, normal);
            vec3 sky = mix(uHaze, uSkyHigh, smoothstep(0.0, 0.6, reflected.y));
            float fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(view, normal), 0.0), 5.0);
            vec3 color = mix(uDeep, sky, clamp(fresnel * 1.3, 0.0, 1.0));

            // The sun's path glittering on the water (bright enough to bloom).
            float sun = max(dot(reflected, uSun), 0.0);
            color += vec3(1.0, 0.88, 0.66) * (pow(sun, 700.0) * 7.0 + pow(sun, 40.0) * 0.18);

            float haze = 1.0 - exp(-dist * 0.013);
            color = mix(color, uHaze, haze * 0.8);
            // Nearer water stays see-through, showing the mirrored village and mountains.
            gl_FragColor = vec4(color, mix(0.58, 0.93, haze));
            #include <colorspace_fragment>
          }`,
      }),
    [],
  );

  return (
    <mesh position={[0, WATER_Y, -210]} rotation-x={-Math.PI / 2} material={material}>
      <planeGeometry args={[700, 400]} />
    </mesh>
  );
}

// ---------- mountains ----------

const MOUNTAIN_LAYERS = [
  { z: -50, height: 13, color: "#55765f", seed: 4 },
  { z: -67, height: 19, color: "#7a9886", seed: 9 },
  { z: -86, height: 25, color: "#a2b8aa", seed: 17 },
];

/** Steep, rounded karst towers along one depth layer. */
function ridgeGeometry(height: number, seed: number): THREE.BufferGeometry {
  const random = seededRandom(seed);
  const peaks = Array.from({ length: 26 }, () => ({
    x: (random() - 0.5) * 260,
    width: 3 + random() * 7,
    height: height * (0.35 + random() * 0.65),
  }));
  const samples = 360;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const x = -140 + (280 * i) / samples;
    let top = 1.2 + Math.sin(x * 0.05 + seed) * 0.8;
    for (const peak of peaks) {
      const d = (x - peak.x) / peak.width;
      if (Math.abs(d) < 1) top = Math.max(top, peak.height * Math.pow(1 - d * d, 0.55));
    }
    // Keep the middle lower so peaks do not crowd the panda's head.
    top *= 0.55 + 0.45 * smoothstep(3, 24, Math.abs(x));
    positions.push(x, -0.6, 0, x, top, 0);
    if (i < samples) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

function Mountains() {
  const layers = useMemo(
    () =>
      MOUNTAIN_LAYERS.map((layer) => ({
        ...layer,
        geometry: ridgeGeometry(layer.height, layer.seed),
        material: new THREE.ShaderMaterial({
          side: THREE.DoubleSide,
          uniforms: {
            uColor: { value: new THREE.Color(layer.color) },
            uHaze: { value: HAZE },
            uWaterY: { value: WATER_Y },
            uHeight: { value: layer.height },
          },
          vertexShader: /* glsl */ `
            varying float vWorldY;
            void main() {
              vec4 world = modelMatrix * vec4(position, 1.0);
              vWorldY = world.y;
              gl_Position = projectionMatrix * viewMatrix * world;
            }`,
          fragmentShader: /* glsl */ `
            uniform vec3 uColor, uHaze;
            uniform float uWaterY, uHeight;
            varying float vWorldY;
            void main() {
              // Height above the water (also correct for the mirrored copy).
              float t = clamp(abs(vWorldY - uWaterY) / uHeight, 0.0, 1.0);
              float mist = 1.0 - smoothstep(0.0, 0.6, t);
              vec3 color = uColor * (0.9 + 0.1 * t);
              gl_FragColor = vec4(mix(color, uHaze, mist * 0.85), 1.0);
              #include <colorspace_fragment>
            }`,
        }),
      })),
    [],
  );

  return (
    <group>
      {layers.map((layer) => (
        <mesh key={layer.z} geometry={layer.geometry} material={layer.material} position={[0, WATER_Y, layer.z]} />
      ))}
    </group>
  );
}

// ---------- village ----------

const WALL = "#ece3cf";
const ROOF = "#3c4852";
const WOOD = "#6b4a33";
const glow = (hex: string, strength: number) => new THREE.Color(hex).multiplyScalar(strength);

function House({ position, width, depth, height, rotation = 0 }: { position: [number, number, number]; width: number; depth: number; height: number; rotation?: number }) {
  const roofHeight = height * 0.6;
  return (
    <group position={position} rotation-y={rotation}>
      <mesh position={[0, height / 2, 0]}>
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial color={WALL} roughness={0.9} />
      </mesh>
      {/* A square hip roof with wide eaves. */}
      <mesh position={[0, height + roofHeight / 2, 0]} rotation-y={Math.PI / 4} scale={[1, 1, depth / width]}>
        <coneGeometry args={[width * 0.86, roofHeight, 4]} />
        <meshStandardMaterial color={ROOF} roughness={0.8} />
      </mesh>
      <mesh position={[width * 0.18, height * 0.45, depth / 2 + 0.01]}>
        <planeGeometry args={[width * 0.22, height * 0.3]} />
        <meshBasicMaterial color={glow("#ffc27a", 2.2)} />
      </mesh>
    </group>
  );
}

function Pagoda({ position }: { position: [number, number, number] }) {
  const tiers = 5;
  let y = 0;
  const parts = [];
  for (let i = 0; i < tiers; i++) {
    const size = 1.5 * (1 - i * 0.14);
    const wall = 0.75;
    const roof = 0.42;
    parts.push(
      <mesh key={`w${i}`} position={[0, y + wall / 2, 0]}>
        <boxGeometry args={[size * 0.68, wall, size * 0.68]} />
        <meshStandardMaterial color="#a9473b" roughness={0.85} />
      </mesh>,
      <mesh key={`r${i}`} position={[0, y + wall + roof / 2, 0]} rotation-y={Math.PI / 4}>
        <coneGeometry args={[size * 0.82, roof, 4]} />
        <meshStandardMaterial color={ROOF} roughness={0.8} />
      </mesh>,
    );
    y += wall + roof * 0.55;
  }
  return (
    <group position={position}>
      {parts}
      <mesh position={[0, y + 0.5, 0]}>
        <cylinderGeometry args={[0.04, 0.06, 1, 6]} />
        <meshStandardMaterial color="#c9a45c" metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh position={[0, y + 1.05, 0]}>
        <sphereGeometry args={[0.13, 10, 8]} />
        <meshBasicMaterial color={glow("#ffb35c", 3)} />
      </mesh>
    </group>
  );
}

function Lanterns({ points }: { points: [number, number, number][] }) {
  const material = useMemo(() => new THREE.MeshBasicMaterial({ color: glow("#ff9f4a", 3.2) }), []);
  const geometry = useMemo(() => new THREE.SphereGeometry(0.11, 8, 6), []);
  return (
    <group>
      {points.map((p, i) => (
        <mesh key={i} position={p} geometry={geometry} material={material} />
      ))}
    </group>
  );
}

/** A small covered sampan drifting near the shore. */
function Boat() {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    const t = windUniforms.uTime.value;
    if (!ref.current) return;
    ref.current.position.y = WATER_Y + 0.12 + Math.sin(t * 1.1) * 0.035;
    ref.current.rotation.z = Math.sin(t * 0.9) * 0.025;
    ref.current.position.x = -7 + Math.sin(t * 0.05) * 1.2;
  });
  return (
    <group ref={ref} position={[-7, WATER_Y + 0.12, -30]} rotation-y={-0.35}>
      <mesh>
        <boxGeometry args={[2.2, 0.22, 0.62]} />
        <meshStandardMaterial color={WOOD} roughness={0.9} />
      </mesh>
      <mesh position={[0.15, 0.2, 0]} rotation-x={Math.PI / 2} rotation-z={Math.PI / 2}>
        <cylinderGeometry args={[0.32, 0.32, 0.85, 12, 1, true, 0, Math.PI]} />
        <meshStandardMaterial color="#b19461" roughness={1} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[-0.95, 0.35, 0]}>
        <sphereGeometry args={[0.08, 8, 6]} />
        <meshBasicMaterial color={glow("#ffb35c", 3)} />
      </mesh>
    </group>
  );
}

/** Village on a green spit of shore to the right, pagoda on a knoll to the left. */
function Village() {
  const houses = useMemo(() => {
    const random = seededRandom(42);
    // In the gap between the panda and the right-hand grove.
    return Array.from({ length: 9 }, (_, i) => ({
      position: [6.8 + i * 0.75 + random() * 0.5, WATER_Y + 0.25, -35 - random() * 5 - (i % 3) * 1.4] as [number, number, number],
      width: 0.9 + random() * 0.6,
      depth: 0.8 + random() * 0.4,
      height: 0.6 + random() * 0.35,
      rotation: (random() - 0.5) * 0.4,
    }));
  }, []);

  const lanterns: [number, number, number][] = [
    ...houses.slice(0, 7).map(({ position: [x, y, z], height }) => [x - 0.5, y + height * 0.85, z + 0.6] as [number, number, number]),
    // Along the pier.
    [6.2, WATER_Y + 0.75, -32.2],
    [5.5, WATER_Y + 0.75, -30.6],
    [4.8, WATER_Y + 0.75, -29],
  ];

  return (
    <group>
      <mesh position={[10.5, WATER_Y + 0.1, -38]} rotation-x={-Math.PI / 2} scale={[1, 0.45, 1]}>
        <circleGeometry args={[8, 40]} />
        <meshStandardMaterial color="#6a8a50" roughness={1} />
      </mesh>
      {houses.map((house, i) => (
        <House key={i} {...house} />
      ))}
      {/* Pier reaching out from the village. */}
      <mesh position={[5.5, WATER_Y + 0.28, -30.6]} rotation-y={0.45}>
        <boxGeometry args={[0.55, 0.08, 4.6]} />
        <meshStandardMaterial color={WOOD} roughness={1} />
      </mesh>
      <Lanterns points={lanterns} />

      {/* Pagoda on a knoll, in the gap left of the panda. */}
      <mesh position={[-11, WATER_Y - 0.6, -46]} scale={[5, 2.6, 3.2]}>
        <sphereGeometry args={[1, 24, 12]} />
        <meshStandardMaterial color="#58784a" roughness={1} />
      </mesh>
      <Pagoda position={[-11, WATER_Y + 1.85, -46]} />
      <Boat />
    </group>
  );
}

// ---------- mist and birds ----------

/** Soft banks of mist lying on the lake, drifting slowly. */
function Mist() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { uTime: windUniforms.uTime, uHaze: { value: HAZE }, uSeed: { value: 0 } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform vec3 uHaze;
          varying vec2 vUv;
          float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
          }
          void main() {
            vec2 p = vec2(vUv.x * 14.0 + uTime * 0.04, vUv.y * 2.0);
            float n = noise(p) * 0.6 + noise(p * 2.3 - uTime * 0.03) * 0.4;
            float shape = smoothstep(1.0, 0.0, vUv.y) * smoothstep(0.0, 0.15, vUv.y);
            float edges = smoothstep(0.0, 0.1, vUv.x) * smoothstep(1.0, 0.9, vUv.x);
            gl_FragColor = vec4(uHaze, shape * edges * smoothstep(0.25, 0.8, n) * 0.6);
            #include <colorspace_fragment>
          }`,
      }),
    [],
  );
  return (
    <group>
      {/* Two banks only, sized to the visible width: each costs a noise lookup per covered pixel. */}
      {[-28, -52].map((z, i) => (
        <mesh key={z} position={[i * 8 - 4, WATER_Y + 1.7 + i * 0.7, z]} material={material}>
          <planeGeometry args={[110 + i * 50, 4.5 + i * 1.5]} />
        </mesh>
      ))}
    </group>
  );
}

/** A few birds gliding across the valley, flapping now and then. */
function Birds() {
  const count = 6;
  const group = useRef<THREE.Group>(null);
  const birds = useMemo(() => {
    const random = seededRandom(77);
    return Array.from({ length: count }, (_, i) => ({
      offset: new THREE.Vector3(i * 1.1 + random() * 0.6, random() * 0.9, random() * 1.5),
      phase: random() * 10,
    }));
  }, []);
  const geometry = useMemo(() => {
    // A simple gull "V": two slim wings.
    const shape = new Float32Array([0, 0, 0, -0.32, 0.1, 0, -0.3, 0.04, 0, 0, 0, 0, 0.3, 0.04, 0, 0.32, 0.1, 0]);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(shape, 3));
    return g;
  }, []);

  useFrame(() => {
    const t = windUniforms.uTime.value;
    if (!group.current) return;
    // Cross the valley in about a minute and a half, then loop.
    group.current.position.set(((t * 0.45) % 90) - 45, 4.5 + Math.sin(t * 0.2) * 0.6, -36);
    group.current.children.forEach((bird, i) => {
      bird.scale.y = 0.55 + 0.45 * Math.max(0, Math.sin(t * 6 + birds[i].phase)) ** 2;
    });
  });

  return (
    <group ref={group}>
      {birds.map((bird, i) => (
        <mesh key={i} geometry={geometry} position={bird.offset}>
          <meshBasicMaterial color="#3a463f" side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

// ---------- assembly ----------

export function Vista() {
  return (
    <group>
      <Terrain />
      <Mountains />
      <Village />
      {/* Upside-down copy under the water surface: the reflection. */}
      <group position={[0, 2 * WATER_Y, 0]} scale={[1, -1, 1]}>
        <Mountains />
        <Village />
      </group>
      <Lake />
      <Mist />
      <Birds />
    </group>
  );
}
