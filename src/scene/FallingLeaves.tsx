import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { seededRandom, windUniforms } from "./wind";

function leafGeometry(): THREE.BufferGeometry {
  // A slender bamboo leaf along +x from its stem at the origin, slightly cupped.
  const segments = 8;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const width = 0.13 * Math.sin(Math.PI * Math.pow(t, 0.62)) * (1 - 0.15 * t);
    const cup = -0.025 * Math.sin(Math.PI * t);
    positions.push(t, width / 2, cup, t, -width / 2, cup);
    if (i < segments) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

interface FallingLeaf {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  spin: THREE.Vector3;
  speed: number;
  phase: number;
}

const COUNT = 26;

/** A few leaves drifting down through the scene, pushed sideways by the wind. */
export function FallingLeaves() {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const random = useMemo(() => seededRandom(21), []);
  const geometry = useMemo(() => leafGeometry(), []);

  const leaves = useMemo<FallingLeaf[]>(
    () =>
      Array.from({ length: COUNT }, () => ({
        position: new THREE.Vector3((random() - 0.5) * 12, random() * 7, 2.5 - random() * 10),
        rotation: new THREE.Euler(random() * 6, random() * 6, random() * 6),
        spin: new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).multiplyScalar(1.6),
        speed: 0.22 + random() * 0.3,
        phase: random() * 10,
      })),
    [random],
  );

  const matrix = useMemo(() => new THREE.Matrix4(), []);
  const quaternion = useMemo(() => new THREE.Quaternion(), []);
  const scale = useMemo(() => new THREE.Vector3(0.42, 0.42, 0.42), []);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    const time = windUniforms.uTime.value;
    const wind = windUniforms.uWind.value;
    leaves.forEach((leaf, i) => {
      leaf.position.y -= leaf.speed * delta;
      leaf.position.x += (0.25 + Math.sin(time * 0.9 + leaf.phase) * 0.35) * wind * delta;
      leaf.position.z += Math.cos(time * 0.7 + leaf.phase) * 0.12 * delta;
      leaf.rotation.x += leaf.spin.x * delta;
      leaf.rotation.y += leaf.spin.y * delta;
      leaf.rotation.z += leaf.spin.z * delta;
      if (leaf.position.y < -0.2 || leaf.position.x > 7) {
        leaf.position.set(-6 + random() * 10, 6.5 + random() * 1.5, 2.5 - random() * 10);
      }
      matrix.compose(leaf.position, quaternion.setFromEuler(leaf.rotation), scale);
      mesh.current?.setMatrixAt(i, matrix);
    });
    if (mesh.current) mesh.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[geometry, undefined, COUNT]} frustumCulled={false}>
      <meshStandardMaterial color="#8aa845" emissive="#4a5a18" emissiveIntensity={0.4} side={THREE.DoubleSide} roughness={0.7} />
    </instancedMesh>
  );
}
