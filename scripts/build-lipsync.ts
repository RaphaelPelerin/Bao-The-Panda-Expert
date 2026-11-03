// Builds the lip-sync assets from a generated talk clip:
//   npx tsx scripts/build-lipsync.ts [--talk raw/bao-talk-….mp4] [--idle public/videos/bao-idle.mp4]
//                                    [--talk-loop public/videos/bao-talk.mp4] [--cells 16]
//
// Writes public/lipsync/mouths.png and public/lipsync/mouths.json:
// - an atlas of real mouth shapes cut out of the talk clip, aligned on the nose,
//   each with its measured openness and width;
// - the nose position on every frame of the idle loop and of the talk loop
//   (made by scripts/make-loop.ts), so the runtime can paste a mouth onto
//   either live video exactly where the head is.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import ffmpegPath from "ffmpeg-static";

const { values } = parseArgs({
  options: {
    talk: { type: "string" },
    idle: { type: "string", default: "public/videos/bao-idle.mp4" },
    "talk-loop": { type: "string", default: "public/videos/bao-talk.mp4" },
    cells: { type: "string", default: "16" },
    out: { type: "string", default: "public/lipsync" },
  },
});

const FFMPEG = ffmpegPath as unknown as string | null;
if (!FFMPEG) fail("ffmpeg-static has no binary for this platform.");

/** Source pixels, relative to the nose center, of the pasted patch: nose, mouth and the fur around them. */
const PATCH = { dx: -216, dy: -74, w: 432, h: 334 };
/**
 * The mask (where the pasted patch replaces the video) is the white fur around
 * the nose and mouth: it fades out `margin + feather` pixels before any black
 * fur (eye patches, collar) seen on any frame of either loop or any atlas cell,
 * so its whole soft edge sits on white fur. Pixels darker than `dark` luma are black fur.
 */
const MASK = { margin: 4, feather: 40, dark: 60 };
/** Region below the nose where mouth pixels are measured. */
const ROI = { x0: -115, x1: 115, y0: 34, y1: 130 };
/** Boxes around each eye, relative to the nose center (mirrored on both sides). */
const EYES = { x0: 55, x1: 195, y0: -170, y1: -45 };
/** Grayscale nose template, at half resolution. */
const TEMPLATE = { w: 64, h: 40 };
const SEARCH = 30;

const talkPath = values.talk ?? (await latest("raw", /^bao-talk-.*\.mp4$/));
const cellCount = Number(values.cells);
if (!Number.isInteger(cellCount) || cellCount < 4 || cellCount > 36) fail("--cells must be 4 to 36.");

console.log(`Talk clip: ${talkPath}\nIdle loop: ${values.idle}`);
const idle = await decode(values.idle!);
const talk = await decode(talkPath);
if (idle.width !== talk.width || idle.height !== talk.height) fail("Both clips must have the same size.");
const { width: W, height: H } = idle;

// 1. Nose template from the first idle frame.
const idleGray = idle.frames.map((f) => halfGray(f, W, H));
const guess = darkCentroid(idle.frames[0], W, Math.round(W * 0.44), Math.round(W * 0.56), Math.round(H * 0.55), Math.round(H * 0.64));
const template = cut(idleGray[0], W / 2, Math.round(guess.x / 2 - TEMPLATE.w / 2), Math.round(guess.y / 2 - TEMPLATE.h / 2), TEMPLATE.w, TEMPLATE.h);
const templateOrigin = { x: guess.x, y: guess.y };
console.log(`Nose found at ${guess.x.toFixed(0)}, ${guess.y.toFixed(0)} on the first idle frame.`);

// 2. Track the nose on every frame of both clips.
const track = (gray: Float32Array[]) => {
  let last = templateOrigin;
  return gray.map((g) => (last = match(g, W / 2, H / 2, template, last)));
};
const idleNose = track(idleGray);
const talkNose = track(talk.frames.map((f) => halfGray(f, W, H)));
const talkLoop = existsSync(values["talk-loop"]!) ? await decode(values["talk-loop"]!) : null;
if (!talkLoop) console.warn(`No talk loop at ${values["talk-loop"]}: the panda will talk over the idle loop.`);
else if (talkLoop.width !== W || talkLoop.height !== H) fail("The talk loop must have the same size as the idle loop.");
const talkLoopNose = talkLoop ? track(talkLoop.frames.map((f) => halfGray(f, W, H))) : null;
const idleEyes = eyeOpenness(idle.frames, idleNose);
const talkEyes = talkLoop && talkLoopNose ? eyeOpenness(talkLoop.frames, talkLoopNose) : null;

// 3. Measure the mouth on every talk frame.
const measures = talk.frames.map((frame, i) => ({ frame: i, ...measureMouth(frame, W, talkNose[i]) }));
const idleClosed = median(idle.frames.map((f, i) => measureMouth(f, W, idleNose[i]).open));

// 4. Keep frames whose head sits close to the idle pose, then spread the picks over the shapes.
const medianNose = { x: median(idleNose.map((n) => n.x)), y: median(idleNose.map((n) => n.y)) };
const usable = measures.filter((m) => {
  if (m.frame === 0) return false; // The start image, before the model's own grade.
  const n = talkNose[m.frame];
  return Math.hypot(n.x - medianNose.x, n.y - medianNose.y) < 26 && m.width > 0;
});
if (usable.length < cellCount) fail(`Only ${usable.length} usable talk frames; lower --cells.`);

const maxOpen = Math.max(...usable.map((m) => m.open));
const widths = usable.map((m) => m.width);
const [minWidth, maxWidth] = [Math.min(...widths), Math.max(...widths)];
const norm = (m: { open: number; width: number }) => ({
  open: clamp01((m.open - idleClosed) / (maxOpen - idleClosed)),
  wide: maxWidth > minWidth ? clamp01((m.width - minWidth) / (maxWidth - minWidth)) : 0.5,
});

// Farthest-point sampling in (open, wide) space, starting from the widest-open mouth.
const picked: typeof usable = [usable.reduce((a, b) => (b.open > a.open ? b : a))];
while (picked.length < cellCount) {
  let best = usable[0];
  let bestDistance = -1;
  for (const m of usable) {
    if (picked.includes(m)) continue;
    const a = norm(m);
    const d = Math.min(...picked.map((p) => {
      const b = norm(p);
      // Openness matters more than width for reading speech.
      return Math.hypot((a.open - b.open) * 1.6, a.wide - b.wide);
    }));
    if (d > bestDistance) [best, bestDistance] = [m, d];
  }
  picked.push(best);
}
picked.sort((a, b) => a.open - b.open);

// 5. Mask: the white fur around the nose and mouth on every frame it will be pasted onto or cut from.
const mask = buildMask([
  ...idle.frames.map((frame, i) => ({ frame, nose: idleNose[i] })),
  ...(talkLoop && talkLoopNose ? talkLoop.frames.map((frame, i) => ({ frame, nose: talkLoopNose[i] })) : []),
  ...picked.map((m) => ({ frame: talk.frames[m.frame], nose: talkNose[m.frame] })),
]);

// 6. Pack the atlas and match each cell's fur color to the idle loop around the mouth.
const gridCols = Math.ceil(Math.sqrt(cellCount));
const gridRows = Math.ceil(cellCount / gridCols);
const atlasW = gridCols * PATCH.w;
const atlasH = gridRows * PATCH.h;
const atlas = Buffer.alloc(atlasW * atlasH * 3);
const idleRing = averageRing(idle.frames, idleNose);

const cells = picked.map((m, index) => {
  const col = index % gridCols;
  const row = Math.floor(index / gridCols);
  const nose = talkNose[m.frame];
  const x0 = Math.round(nose.x + PATCH.dx);
  const y0 = Math.round(nose.y + PATCH.dy);
  for (let y = 0; y < PATCH.h; y++) {
    for (let x = 0; x < PATCH.w; x++) {
      const sx = clamp(x0 + x, 0, W - 1);
      const sy = clamp(y0 + y, 0, H - 1);
      const s = (sy * W + sx) * 3;
      const d = ((row * PATCH.h + y) * atlasW + col * PATCH.w + x) * 3;
      talk.frames[m.frame].copy(atlas, d, s, s + 3);
    }
  }
  const ring = averageRing([talk.frames[m.frame]], [nose]);
  const gain = ring.map((c, k) => round(clamp(idleRing[k] / Math.max(1, c), 0.85, 1.15), 4));
  const shape = norm(m);
  return { frame: m.frame, col, row, open: round(shape.open, 3), wide: round(shape.wide, 3), gain };
});

await mkdir(values.out!, { recursive: true });
await encodePng(atlas, atlasW, atlasH, join(values.out!, "mouths.png"));
await encodePng(Buffer.from(mask), PATCH.w, PATCH.h, join(values.out!, "mouths-mask.png"), "gray");
const manifest = {
  source: talkPath.replace(/\\/g, "/"),
  fps: idle.fps,
  size: [W, H],
  patch: PATCH,
  /** Grayscale image, the size of the patch: how much of the pasted patch shows. */
  mask: "mouths-mask.png",
  atlas: { width: atlasW, height: atlasH, cols: gridCols, rows: gridRows },
  cells,
  /** Nose center in source pixels (origin top-left), one entry per idle loop frame. */
  idleNose: idleNose.map((n) => [round(n.x, 1), round(n.y, 1)]),
  /** Same, for the talk loop; absent when there is none. */
  talkNose: talkLoopNose?.map((n) => [round(n.x, 1), round(n.y, 1)]),
  /** How open the eyes are on each frame, 0 (closed) to about 1 (wide open), per loop. */
  idleEyes,
  talkEyes,
};
await writeFile(join(values.out!, "mouths.json"), JSON.stringify(manifest, null, 1));
console.log(`Picked frames ${cells.map((c) => c.frame).join(", ")}.`);
console.log(`Wrote ${join(values.out!, "mouths.png")} (${atlasW}×${atlasH}), mouths-mask.png and mouths.json.`);

// ---------------------------------------------------------------------------

interface Clip {
  width: number;
  height: number;
  fps: number;
  frames: Buffer[];
}

async function decode(path: string): Promise<Clip> {
  const info = await run(["-hide_banner", "-i", path], true);
  const size = /, (\d{2,5})x(\d{2,5})[, ]/.exec(info);
  const fps = /([\d.]+) fps/.exec(info);
  if (!size) fail(`Could not read the size of ${path}.`);
  const width = Number(size[1]);
  const height = Number(size[2]);
  const raw = await runBinary(["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const frameBytes = width * height * 3;
  const frames: Buffer[] = [];
  for (let offset = 0; offset + frameBytes <= raw.length; offset += frameBytes) frames.push(raw.subarray(offset, offset + frameBytes));
  return { width, height, fps: fps ? Number(fps[1]) : 24, frames };
}

function halfGray(frame: Buffer, w: number, h: number): Float32Array {
  const hw = w / 2;
  const out = new Float32Array(hw * (h / 2));
  for (let y = 0; y < h / 2; y++) {
    for (let x = 0; x < hw; x++) {
      let sum = 0;
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((y * 2 + oy) * w + x * 2 + ox) * 3;
        sum += luma(frame[i], frame[i + 1], frame[i + 2]);
      }
      out[y * hw + x] = sum / 4;
    }
  }
  return out;
}

function cut(gray: Float32Array, w: number, x0: number, y0: number, tw: number, th: number): Float32Array {
  const out = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) out[y * tw + x] = gray[(y0 + y) * w + x0 + x];
  return out;
}

/** Finds the template near the previous position; returns the nose center in full-resolution pixels. */
function match(gray: Float32Array, w: number, h: number, tpl: Float32Array, near: { x: number; y: number }) {
  const cx = Math.round(near.x / 2 - TEMPLATE.w / 2);
  const cy = Math.round(near.y / 2 - TEMPLATE.h / 2);
  const range = SEARCH / 2;
  const costs = new Map<string, number>();
  let best = { x: cx, y: cy, cost: Infinity };
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      const x0 = cx + dx;
      const y0 = cy + dy;
      if (x0 < 0 || y0 < 0 || x0 + TEMPLATE.w > w || y0 + TEMPLATE.h > h) continue;
      let cost = 0;
      for (let y = 0; y < TEMPLATE.h; y++) {
        const row = (y0 + y) * w + x0;
        const trow = y * TEMPLATE.w;
        for (let x = 0; x < TEMPLATE.w; x++) cost += Math.abs(gray[row + x] - tpl[trow + x]);
      }
      costs.set(`${x0},${y0}`, cost);
      if (cost < best.cost) best = { x: x0, y: y0, cost };
    }
  }
  // Sub-pixel refinement with a parabola through the neighbors.
  const at = (x: number, y: number) => costs.get(`${x},${y}`) ?? best.cost;
  const sub = (a: number, b: number, c: number) => (a - 2 * b + c > 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0);
  const fx = best.x + sub(at(best.x - 1, best.y), best.cost, at(best.x + 1, best.y));
  const fy = best.y + sub(at(best.x, best.y - 1), best.cost, at(best.x, best.y + 1));
  return { x: (fx + TEMPLATE.w / 2) * 2, y: (fy + TEMPLATE.h / 2) * 2 };
}

function darkCentroid(frame: Buffer, w: number, x0: number, x1: number, y0: number, y1: number) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 3;
      if (luma(frame[i], frame[i + 1], frame[i + 2]) < 55) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  if (n < 200) fail("Could not find the nose on the first idle frame.");
  return { x: sx / n, y: sy / n };
}

/**
 * Openness: average vertical span of dark or red (lips, inner mouth) pixels per
 * column, teeth included since they sit between them. Width: how many columns
 * contain any.
 */
function measureMouth(frame: Buffer, w: number, nose: { x: number; y: number }) {
  const spans: number[] = [];
  let columns = 0;
  for (let dx = ROI.x0; dx <= ROI.x1; dx++) {
    if (Math.abs(dx) < 9) continue; // The philtrum line under the nose.
    const x = Math.round(nose.x + dx);
    let top = -1;
    let bottom = -1;
    for (let dy = ROI.y0; dy <= ROI.y1; dy++) {
      const y = Math.round(nose.y + dy);
      const i = (y * w + x) * 3;
      const [r, g, b] = [frame[i], frame[i + 1], frame[i + 2]];
      if (luma(r, g, b) < 95 || (r - g > 45 && r < 210)) {
        if (top < 0) top = dy;
        bottom = dy;
      }
    }
    if (top < 0) continue;
    columns++;
    if (Math.abs(dx) < 55) spans.push(bottom - top + 1);
  }
  return { open: spans.length ? spans.reduce((a, b) => a + b) / spans.length : 0, width: columns };
}

/**
 * Visible iris per frame (saturated brown pixels around each eye, which the
 * lids hide during a blink), relative to the clip's usual open eyes.
 */
function eyeOpenness(frames: Buffer[], noses: { x: number; y: number }[]): number[] {
  const counts = frames.map((frame, f) => {
    const { x: nx, y: ny } = noses[f];
    let count = 0;
    for (let y = Math.round(ny + EYES.y0); y < ny + EYES.y1; y++) {
      for (const [x0, x1] of [[-EYES.x1, -EYES.x0], [EYES.x0, EYES.x1]]) {
        for (let x = Math.round(nx + x0); x < nx + x1; x++) {
          const i = (clamp(y, 0, H - 1) * W + clamp(x, 0, W - 1)) * 3;
          const [r, g, b] = [frame[i], frame[i + 1], frame[i + 2]];
          const l = luma(r, g, b);
          if (r - b > 45 && r > g && l > 25 && l < 175) count++;
        }
      }
    }
    return count;
  });
  const open = [...counts].sort((a, b) => a - b)[Math.floor(counts.length * 0.9)] || 1;
  return counts.map((c) => round(c / open, 2));
}

/** Mean fur color in the mask's soft edge, where the pasted patch meets the video. */
function averageRing(frames: Buffer[], noses: { x: number; y: number }[]): number[] {
  const sum = [0, 0, 0];
  let n = 0;
  frames.forEach((frame, f) => {
    const x0 = Math.round(noses[f].x + PATCH.dx);
    const y0 = Math.round(noses[f].y + PATCH.dy);
    for (let y = 0; y < PATCH.h; y += 2) {
      for (let x = 0; x < PATCH.w; x += 2) {
        const a = mask[y * PATCH.w + x];
        if (a < 10 || a > 160) continue;
        const i = (clamp(y0 + y, 0, H - 1) * W + clamp(x0 + x, 0, W - 1)) * 3;
        if (luma(frame[i], frame[i + 1], frame[i + 2]) < 120) continue; // Fur only, not lips or nose.
        for (let k = 0; k < 3; k++) sum[k] += frame[i + k];
        n++;
      }
    }
  });
  return sum.map((s) => s / Math.max(1, n));
}

/**
 * The mask over the patch, 0–255 per pixel. On every sample, black fur is the
 * dark pixels joined to the patch border (eye patches, collar), and the core is
 * the nose and the mouth: dark or red pixels apart from it. The mask covers
 * every core pixel of every sample, stays `margin` pixels off black fur seen on
 * any sample, and fades in between over up to `feather` pixels, less where the
 * mouth corners come close to the eye patches.
 */
function buildMask(samples: { frame: Buffer; nose: { x: number; y: number } }[]): Uint8Array {
  const { w, h } = PATCH;
  const size = w * h;
  const black = new Uint8Array(size);
  const core = new Uint8Array(size);
  const ox = -PATCH.dx;
  const oy = -PATCH.dy;
  const inCore = (x: number, y: number) =>
    (Math.abs(x) < 80 && y > -50 && y < 40) || (Math.abs(x) < 140 && y >= 0 && y < 150);
  for (const { frame, nose } of samples) {
    const x0 = Math.round(nose.x + PATCH.dx);
    const y0 = Math.round(nose.y + PATCH.dy);
    const dark = new Uint8Array(size);
    const feature = new Uint8Array(size);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (clamp(y0 + y, 0, H - 1) * W + clamp(x0 + x, 0, W - 1)) * 3;
        const [r, g, b] = [frame[i], frame[i + 1], frame[i + 2]];
        const l = luma(r, g, b);
        dark[y * w + x] = l < MASK.dark ? 1 : 0;
        feature[y * w + x] = l < 95 || (r - g > 45 && r < 210) ? 1 : 0;
      }
    }
    const frameBlack = new Uint8Array(size);
    const stack: number[] = [];
    for (let k = 0; k < size; k++) if (dark[k] && onBorder(k)) stack.push(k);
    while (stack.length) {
      const k = stack.pop()!;
      if (!dark[k]) continue;
      dark[k] = 0;
      frameBlack[k] = black[k] = 1;
      stack.push(...neighbors(k));
    }
    // Not the gray fringe of the black fur.
    const toFrameBlack = distanceTo((k) => frameBlack[k] === 1);
    for (let k = 0; k < size; k++) {
      const x = k % w;
      if (feature[k] && toFrameBlack[k] > 10 && inCore(x - ox, (k - x) / w - oy)) core[k] = 1;
    }
  }

  const toCore = distanceTo((k) => core[k] === 1);
  // Closes the gaps between lips, teeth and the philtrum line, so the core is solid.
  const fromOutside = distanceTo((k) => toCore[k] > 6);
  const toBlack = distanceTo((k) => (black[k] === 1 && fromOutside[k] <= 6) || onBorder(k));
  const toSolid = distanceTo((k) => fromOutside[k] > 6);

  const out = new Uint8Array(size);
  let tightest = Infinity;
  for (let k = 0; k < size; k++) {
    if (toSolid[k] === 0) {
      out[k] = 255;
      tightest = Math.min(tightest, toBlack[k]);
      continue;
    }
    const room = toBlack[k] - MASK.margin;
    if (room <= 0) continue;
    const t = clamp01(room / Math.min(MASK.feather, room + toSolid[k]));
    out[k] = Math.round(t * t * (3 - 2 * t) * 255);
  }
  if (!out[oy * w + ox]) fail("The mask misses the nose.");
  console.log(`Mask: the nose and mouth come within ${tightest.toFixed(0)} px of black fur at the closest.`);
  return out;

  function onBorder(k: number): boolean {
    const x = k % w;
    const y = (k - x) / w;
    return x === 0 || y === 0 || x === w - 1 || y === h - 1;
  }

  function neighbors(k: number): number[] {
    const x = k % w;
    const list: number[] = [];
    if (x > 0) list.push(k - 1);
    if (x < w - 1) list.push(k + 1);
    if (k >= w) list.push(k - w);
    if (k < size - w) list.push(k + w);
    return list;
  }

  /** Distance in pixels from every pixel to the nearest one in the set (two-pass chamfer). */
  function distanceTo(inSet: (k: number) => boolean): Float32Array {
    const dist = new Float32Array(size);
    for (let k = 0; k < size; k++) dist[k] = inSet(k) ? 0 : Infinity;
    const steps = [[-1, 0, 1], [0, -1, 1], [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2]];
    for (const pass of [1, -1]) {
      for (let n = 0; n < size; n++) {
        const k = pass > 0 ? n : size - 1 - n;
        const x = k % w;
        const y = (k - x) / w;
        for (const [sx, sy, cost] of steps) {
          const nx = x + sx * pass;
          const ny = y + sy * pass;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          dist[k] = Math.min(dist[k], dist[ny * w + nx] + cost);
        }
      }
    }
    return dist;
  }
}

async function encodePng(pixels: Buffer, w: number, h: number, path: string, format = "rgb24"): Promise<void> {
  await runBinary(["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", format, "-s", `${w}x${h}`, "-i", "-", "-frames:v", "1", path], pixels);
}

function run(args: string[], allowFailure = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG!, args);
    let text = "";
    child.stderr.on("data", (d) => (text += d));
    child.stdout.on("data", (d) => (text += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 || allowFailure ? resolve(text) : reject(new Error(text))));
  });
}

function runBinary(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG!, args);
    const chunks: Buffer[] = [];
    let errors = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d) => (errors += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(errors))));
    if (input) child.stdin.end(input);
  });
}

async function latest(dir: string, pattern: RegExp): Promise<string> {
  const files = (await readdir(dir)).filter((f) => pattern.test(f)).sort();
  if (!files.length) fail(`No file matching ${pattern} in ${dir}/. Generate one with scripts/generate-video.ts --state talk.`);
  return join(dir, files[files.length - 1]);
}

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
function round(v: number, digits: number): number {
  return Number(v.toFixed(digits));
}
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
