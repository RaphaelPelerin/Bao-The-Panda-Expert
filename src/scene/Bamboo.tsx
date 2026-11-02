import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { WIND_GLSL, seededRandom, tmpMatrix, windUniforms } from "./wind";

export interface Stalk {
  x: number;
  z: number;
  height: number;
  radius: number;
  color: THREE.Color;
  leaves: number;
}

/** Converts wind displacement (unitless) into world units, scaled by stalk height. */
const BEND = 0.045;
const PALETTE = ["#6f9a3c", "#86a94a", "#5c8a3a", "#9db35a", "#4f7d3a", "#7ea844"].map((c) => new THREE.Color(c));
const LEAF_PALETTE = ["#5f8f2f", "#77a83a", "#4c7d28", "#8fb84a", "#6a9a33"].map((c) => new THREE.Color(c));

// ---------- geometry ----------

function stalkGeometry(): THREE.BufferGeometry {
  // Unit-height cylinder with its base at y=0, so instance scale.y is the stalk height.
  const geometry = new THREE.CylinderGeometry(1, 1.08, 1, 10, 32, true);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

export function leafGeometry(): THREE.BufferGeometry {
  // A slender bamboo leaf along +x from its stem at the origin, slightly cupped.
  const segments = 8;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const width = 0.13 * Math.sin(Math.PI * Math.pow(t, 0.62)) * (1 - 0.15 * t);
    const cup = -0.025 * Math.sin(Math.PI * t);
    positions.push(t, width / 2, cup, t, -width / 2, cup);
    uvs.push(t, 1, t, 0);
    if (i < segments) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// ---------- materials ----------

function stalkMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWind = windUniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${WIND_GLSL}\nvarying float vNodeY;\nvarying float vSeed;`)
      .replace(
        "#include <project_vertex>",
        /* glsl */ `
        vec4 mvPosition = vec4(transformed, 1.0);
        mvPosition = instanceMatrix * mvPosition;
        vec3 root = instanceMatrix[3].xyz;
        float stalkH = length(instanceMatrix[1].xyz);
        mvPosition.xz += windOffset(root, clamp(position.y, 0.0, 1.0)) * stalkH * ${BEND};
        vNodeY = position.y * stalkH;
        vSeed = fract(sin(root.x * 12.9898 + root.z * 78.233) * 43758.5453);
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vNodeY;\nvarying float vSeed;")
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        // Nodes every ~1.1m: a dark ring with a pale, powdery band just above it.
        float seg = fract(vNodeY / (0.95 + vSeed * 0.35) + vSeed);
        float node = 1.0 - smoothstep(0.0, 0.025, seg) * smoothstep(1.0, 0.975, seg);
        float powder = smoothstep(0.02, 0.05, seg) * (1.0 - smoothstep(0.05, 0.16, seg));
        diffuseColor.rgb *= mix(1.0, 0.45, node);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.88, 0.7), powder * 0.35);
        // Older, yellower culms near the ground.
        diffuseColor.rgb = mix(diffuseColor.rgb * vec3(1.1, 1.0, 0.75), diffuseColor.rgb, smoothstep(0.0, 2.5, vNodeY));`,
      );
  };
  material.customProgramCacheKey = () => "bamboo-stalk";
  return material;
}

function leafMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    side: THREE.DoubleSide,
    roughness: 0.65,
    emissive: new THREE.Color("#3b5214"),
    emissiveIntensity: 0.35,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWind = windUniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${WIND_GLSL}\nattribute vec4 aStalk;`)
      .replace(
        "#include <project_vertex>",
        /* glsl */ `
        vec4 mvPosition = instanceMatrix * vec4(transformed, 1.0);
        // aStalk: root x, root z, attach height (0..1 of the stalk), stalk height.
        vec3 root = vec3(aStalk.x, 0.0, aStalk.y);
        mvPosition.xz += windOffset(root, aStalk.z) * aStalk.w * ${BEND};
        // Leaves flutter faster than the stalk sways, more toward their tips.
        float flutter = sin(uTime * 7.0 + aStalk.x * 13.0 + aStalk.z * 31.0 + position.x * 2.5);
        mvPosition.y += flutter * 0.035 * position.x * (0.6 + uWind * 0.5);
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  material.customProgramCacheKey = () => "bamboo-leaf";
  return material;
}

// ---------- layout ----------

export function makeStalk(random: () => number, x: number, z: number, near: boolean): Stalk {
  return {
    x,
    z,
    height: 9 + random() * 6,
    radius: near ? 0.15 + random() * 0.05 : 0.055 + random() * 0.065,
    color: PALETTE[Math.floor(random() * PALETTE.length)].clone().multiplyScalar(0.85 + random() * 0.3),
    leaves: near ? 34 : z > -8 ? 30 : 16,
  };
}

/** The forest behind the panda, in two depth bands with a small clearing behind its head. */
export function forestLayout(): Stalk[] {
  const random = seededRandom(7);
  const stalks: Stalk[] = [];
  for (let i = 0; i < 150; i++) {
    stalks.push(makeStalk(random, (random() - 0.5) * 34, -8 - random() * 20, false));
  }
  for (let i = 0; i < 46; i++) {
    let x = (random() - 0.5) * 14;
    if (Math.abs(x) < 1.1) x += Math.sign(x || 1) * 1.1;
    stalks.push(makeStalk(random, x, -2.4 - random() * 5.6, false));
  }
  return stalks;
}

// ---------- component ----------

export function BambooGroup({ stalks, seed }: { stalks: Stalk[]; seed: number }) {
  const stalkMesh = useRef<THREE.InstancedMesh>(null);
  const leafMesh = useRef<THREE.InstancedMesh>(null);

  const geometries = useMemo(() => ({ stalk: stalkGeometry(), leaf: leafGeometry() }), []);
  const materials = useMemo(() => ({ stalk: stalkMaterial(), leaf: leafMaterial() }), []);
  const leafCount = stalks.reduce((sum, s) => sum + s.leaves, 0);

  useLayoutEffect(() => {
    const stalksMesh = stalkMesh.current;
    const leavesMesh = leafMesh.current;
    if (!stalksMesh || !leavesMesh) return;
    const random = seededRandom(seed);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const euler = new THREE.Euler();
    const stalkInfo = new Float32Array(leafCount * 4);

    let leafIndex = 0;
    stalks.forEach((stalk, i) => {
      // Stalks lean very slightly, like real culms competing for light.
      euler.set((random() - 0.5) * 0.05, 0, (random() - 0.5) * 0.05);
      quaternion.setFromEuler(euler);
      tmpMatrix.compose(position.set(stalk.x, 0, stalk.z), quaternion, scale.set(stalk.radius, stalk.height, stalk.radius));
      stalksMesh.setMatrixAt(i, tmpMatrix);
      stalksMesh.setColorAt(i, stalk.color);

      // Leaves hang in clusters from short twigs at a few nodes.
      let remaining = stalk.leaves;
      while (remaining > 0) {
        const clusterSize = Math.min(remaining, 4 + Math.floor(random() * 4));
        const attachY = 2.2 + random() * Math.min(stalk.height - 2.2, 6);
        const twigAngle = random() * Math.PI * 2;
        const twigLength = 0.12 + random() * 0.45;
        for (let k = 0; k < clusterSize; k++) {
          const yaw = twigAngle + (random() - 0.5) * 1.6;
          euler.set((random() - 0.5) * 0.6, yaw, -0.55 - random() * 0.8, "YXZ");
          quaternion.setFromEuler(euler);
          const length = (stalk.radius > 0.14 ? 0.55 : 0.38) + random() * 0.3;
          position.set(
            stalk.x + Math.cos(twigAngle) * twigLength,
            attachY + (random() - 0.5) * 0.25,
            stalk.z - Math.sin(twigAngle) * twigLength,
          );
          tmpMatrix.compose(position, quaternion, scale.set(length, length * (0.9 + random() * 0.4), length));
          leavesMesh.setMatrixAt(leafIndex, tmpMatrix);
          leavesMesh.setColorAt(leafIndex, LEAF_PALETTE[Math.floor(random() * LEAF_PALETTE.length)]);
          stalkInfo.set([stalk.x, stalk.z, Math.min(1, attachY / stalk.height), stalk.height], leafIndex * 4);
          leafIndex++;
        }
        remaining -= clusterSize;
      }
    });

    leavesMesh.geometry.setAttribute("aStalk", new THREE.InstancedBufferAttribute(stalkInfo, 4));
    for (const mesh of [stalksMesh, leavesMesh]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // Wind moves vertices outside the static bounds; never cull the forest.
      mesh.frustumCulled = false;
    }
  }, [stalks, seed, leafCount]);

  return (
    <group>
      <instancedMesh
        key={`stalks-${stalks.length}`}
        ref={stalkMesh}
        args={[geometries.stalk, materials.stalk, stalks.length]}
      />
      <instancedMesh
        key={`leaves-${leafCount}`}
        ref={leafMesh}
        args={[geometries.leaf, materials.leaf, leafCount]}
      />
    </group>
  );
}
