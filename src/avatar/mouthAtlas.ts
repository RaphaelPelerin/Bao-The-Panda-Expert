import * as THREE from "three";

/** Written by scripts/build-lipsync.ts. */
interface Manifest {
  fps: number;
  size: [number, number];
  patch: { dx: number; dy: number; w: number; h: number };
  /** Grayscale image the size of the patch: how much of the pasted patch shows. */
  mask: string;
  atlas: { width: number; height: number; cols: number; rows: number };
  cells: { frame: number; col: number; row: number; open: number; wide: number; gain: [number, number, number] }[];
  idleNose: [number, number][];
  talkNose?: [number, number][];
  idleEyes?: number[];
  talkEyes?: number[];
}

/**
 * Eye openness (relative to the clip's usual open eyes) that counts as open.
 * Blinks drop below 0.3; a smiling squint, eyes still clearly visible, sits around 0.6.
 */
const EYES_OPEN = 0.55;

export type Loop = "idle" | "talk";

export interface MouthCell {
  index: number;
  /** Column and row in the atlas grid. */
  cell: THREE.Vector2;
  gain: THREE.Vector3;
}

/** Openness reads first when lip reading, so it weighs more than width. */
const OPEN_WEIGHT = 1.6;
/** A new cell must be this much closer before it replaces the current one. */
const HYSTERESIS = 0.05;

/**
 * Real mouth shapes cut out of the talk clip, and where the mouth sits on each
 * frame of the idle loop, so a mouth can be pasted onto the live video.
 */
export class MouthAtlas {
  private current = 0;

  private constructor(
    readonly texture: THREE.Texture,
    /** Where the pasted patch replaces the video (red channel), in patch space. */
    readonly mask: THREE.Texture,
    private readonly manifest: Manifest,
    private readonly cells: MouthCell[],
  ) {}

  static async load(base = "/lipsync"): Promise<MouthAtlas> {
    const response = await fetch(`${base}/mouths.json`);
    if (!response.ok) throw new Error(`No lip-sync atlas (${response.status}).`);
    const manifest = (await response.json()) as Manifest;
    if (typeof manifest.mask !== "string") throw new Error("Lip-sync atlas too old: rebuild it with npm run lipsync.");
    const loader = new THREE.TextureLoader();
    const [texture, mask] = await Promise.all([
      loader.loadAsync(`${base}/mouths.png`),
      loader.loadAsync(`${base}/${manifest.mask}`),
    ]);
    // Sampled like the video texture (see videoLoop.ts), or the pasted mouth shows darker or softer.
    for (const t of [texture, mask]) {
      t.colorSpace = THREE.NoColorSpace;
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
    }
    const cells = manifest.cells.map((c, index) => ({
      index,
      cell: new THREE.Vector2(c.col, c.row),
      gain: new THREE.Vector3(...c.gain),
    }));
    return new MouthAtlas(texture, mask, manifest, cells);
  }

  get grid(): THREE.Vector2 {
    return new THREE.Vector2(this.manifest.atlas.cols, this.manifest.atlas.rows);
  }

  /** The closest mouth shape to the target. */
  pick(open: number, wide: number): MouthCell {
    const distance = (i: number) => {
      const c = this.manifest.cells[i];
      return Math.hypot((c.open - open) * OPEN_WEIGHT, c.wide - wide);
    };
    let best = this.current;
    for (let i = 0; i < this.cells.length; i++) if (distance(i) < distance(best)) best = i;
    if (best !== this.current && distance(best) < distance(this.current) - HYSTERESIS) this.current = best;
    return this.cells[this.current];
  }

  /** Whether the talk loop was tracked, so a mouth can be pasted onto it. */
  get hasTalkLoop(): boolean {
    return !!this.manifest.talkNose?.length;
  }

  /**
   * Whether the eyes stay open on every frame of `loop` from `mediaTime` for
   * `seconds`. True when the atlas has no eye data, so switching never stalls.
   */
  eyesOpen(loop: Loop, mediaTime: number, seconds: number): boolean {
    const eyes = this.eyes(loop);
    if (!eyes?.length) return true;
    return this.openFrom(eyes, Math.floor(mediaTime * this.manifest.fps + 0.01), seconds);
  }

  /**
   * The media time of the next frame of `loop`, from `mediaTime`, after which
   * the eyes stay open for `seconds`; null if there is none.
   */
  nextOpen(loop: Loop, mediaTime: number, seconds: number): number | null {
    const eyes = this.eyes(loop);
    if (!eyes?.length) return null;
    const { fps } = this.manifest;
    const now = Math.floor(mediaTime * fps + 0.01);
    for (let i = 1; i <= eyes.length; i++) {
      const frame = (now + i) % eyes.length;
      // Aim at the middle of the frame so the decoder lands on it.
      if (this.openFrom(eyes, frame, seconds)) return (frame + 0.5) / fps;
    }
    return null;
  }

  private eyes(loop: Loop): number[] | undefined {
    return loop === "talk" ? this.manifest.talkEyes : this.manifest.idleEyes;
  }

  private openFrom(eyes: number[], frame: number, seconds: number): boolean {
    const count = Math.ceil(seconds * this.manifest.fps) + 1;
    for (let i = 0; i < count; i++) if (eyes[(frame + i) % eyes.length] < EYES_OPEN) return false;
    return true;
  }

  /**
   * Where the mouth patch sits on a loop at `mediaTime` seconds, in texture
   * space from the top-left: x, y, width, height.
   */
  patchAt(mediaTime: number, out: THREE.Vector4, loop: Loop = "idle"): THREE.Vector4 {
    const { fps, size, patch } = this.manifest;
    const track = (loop === "talk" && this.manifest.talkNose) || this.manifest.idleNose;
    const frame = Math.floor(mediaTime * fps + 0.01) % track.length;
    const [x, y] = track[Math.max(0, frame)];
    return out.set((x + patch.dx) / size[0], (y + patch.dy) / size[1], patch.w / size[0], patch.h / size[1]);
  }
}
