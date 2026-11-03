// Turns a generated clip into a seamless loop:
//   npx tsx scripts/make-loop.ts --in raw/bao-talk-….mp4 --out public/videos/bao-talk.mp4
//   npx tsx scripts/make-loop.ts --state talk      (latest raw/bao-talk-*.mp4 → public/videos/bao-talk.mp4)
//   --ignore-mouth  judge the join on the rest of the face only (the talk loop's
//                   mouth is covered by the lip-synced one anyway)
//   --pingpong      play forward then backward instead of cross-fading: no blend
//                   at all, for clips whose head never comes back to the same place
//
// Generated clips open on the start image in a slightly different color grade,
// and their last frame never quite matches their first. This skips the opening
// frames until the grade settles, then finds where to join the end back onto
// the start so the short cross-fade between them never blends two different
// poses (a blink against open eyes, for example).

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import ffmpegPath from "ffmpeg-static";

const { values } = parseArgs({
  options: {
    in: { type: "string" },
    out: { type: "string" },
    state: { type: "string" },
    "ignore-mouth": { type: "boolean", default: false },
    pingpong: { type: "boolean", default: false },
  },
});

const FFMPEG = ffmpegPath as unknown as string | null;
if (!FFMPEG) fail("ffmpeg-static has no binary for this platform.");
if (!values.in && !values.state) fail("Pass --in <clip> --out <loop>, or --state idle|talk|think.");

const input = values.in ?? (await latest("raw", new RegExp(`^bao-${values.state}-.*\\.mp4$`)));
const output = values.out ?? join("public", "videos", `bao-${values.state ?? "loop"}.mp4`);

/** Metrics run on a small grayscale copy of the face area. */
const SIZE = 128;
const CROP = "crop=iw*0.7:ih*0.7:iw*0.15:ih*0.1";

const info = await run(["-hide_banner", "-i", input], true);
const fps = Number(/([\d.]+) fps/.exec(info)?.[1] ?? 24);
const raw = await runBinary(["-v", "error", "-i", input, "-vf", `${CROP},scale=${SIZE}:${SIZE}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
const px = SIZE * SIZE;
const n = Math.floor(raw.length / px);
if (n < 48) fail(`${input} is too short to loop (${n} frames).`);
const frame = (i: number) => raw.subarray(i * px, (i + 1) * px);
const mean = (i: number) => frame(i).reduce((a, b) => a + b, 0) / px;
// How much each pixel counts when comparing frames. Eyes weigh most: a blink
// blended against open eyes shows as ghost eyelids. The mouth sits around the
// lower middle of the crop.
const weight = new Float32Array(px).fill(1);
const region = (y0: number, y1: number, x0: number, x1: number, w: number) => {
  for (let y = Math.floor(SIZE * y0); y < Math.ceil(SIZE * y1); y++) {
    for (let x = Math.floor(SIZE * x0); x < Math.ceil(SIZE * x1); x++) weight[y * SIZE + x] = w;
  }
};
region(0.45, 0.68, 0.15, 0.85, 4);
if (values["ignore-mouth"]) region(0.7, 0.96, 0.18, 0.82, 0);
const weightTotal = weight.reduce((a, b) => a + b, 0);
const diff = (i: number, j: number) => {
  const a = frame(i);
  const b = frame(j);
  let sum = 0;
  for (let k = 0; k < px; k++) sum += Math.abs(a[k] - b[k]) * weight[k];
  return sum / weightTotal;
};

// 1. Skip the opening frames until the brightness settles on the clip's own grade.
const brightness = Array.from({ length: n }, (_, i) => mean(i));
const settled = median(brightness.slice(Math.floor(n / 3)));
let first = 1;
while (first < n / 3 && Math.abs(brightness[first] - settled) > 0.6) first++;

const encode = ["-map", "[out]", "-an", "-r", String(fps), "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-g", String(Math.round(fps)), "-movflags", "+faststart", output];
if (values.pingpong) {
  const count = n - first;
  // The reversed half drops its first and last frames, which the forward half already shows.
  const filter = [
    `[0:v]trim=start_frame=${first},setpts=PTS-STARTPTS,split[f][r]`,
    `[r]reverse,trim=start_frame=1:end_frame=${count - 1},setpts=PTS-STARTPTS[b]`,
    `[f][b]concat=n=2:v=1:a=0,format=yuv420p[out]`,
  ].join(";");
  await run(["-v", "error", "-y", "-i", input, "-filter_complex", filter, ...encode]);
  const frames = 2 * count - 2;
  console.log(`${input}
  skipped ${first} opening frame(s), forward then backward
  wrote ${output}: ${frames} frames, ${(frames / fps).toFixed(2)} s`);
  process.exit(0);
}

// 2. Find the join: the loop plays [start + fade, end - fade], then the last
//    `fade` frames blend into [start, start + fade). Every blended pair must
//    match, and longer fades spread what difference remains.
const steps: number[] = [];
for (let i = first + 1; i < n; i++) steps.push(diff(i, i - 1));
const normalStep = median(steps);
// Every pair once, so the search below can try joins anywhere in the clip.
const pair = new Float32Array(n * n);
for (let i = first; i < n; i++) for (let j = first; j < i; j++) pair[i * n + j] = pair[j * n + i] = diff(i, j);
let best = { start: first, fade: 6, end: n - 1, cost: Infinity, worst: 0 };
for (let start = first; start < n; start++) {
  for (let fade = 6; fade <= 18; fade++) {
    for (let end = n - 1; end > start; end--) {
      const tail = end - fade + 1;
      if (tail - (start + fade) < n * 0.45) continue; // Keep most of the clip.
      let worst = 0;
      for (let k = 0; k < fade; k++) worst = Math.max(worst, pair[(tail + k) * n + start + k]);
      const cost = worst * (0.15 + 1 / fade);
      if (cost < best.cost) best = { start, fade, end, cost, worst };
    }
  }
}
const { start, fade, end } = best;
const tail = end - fade + 1;

// 3. Render: body, then the tail cross-fading into the head.
const filter = [
  `[0:v]split=3[a][b][c]`,
  `[a]trim=start_frame=${start}:end_frame=${start + fade},setpts=PTS-STARTPTS[head]`,
  `[b]trim=start_frame=${start + fade}:end_frame=${tail},setpts=PTS-STARTPTS[body]`,
  `[c]trim=start_frame=${tail}:end_frame=${end + 1},setpts=PTS-STARTPTS[tail]`,
  // The blend's frame counter N starts at 1, so the last tail frame is fully the head's.
  `[tail][head]blend=all_expr='A*(1-clip(N/${fade}\\,0\\,1))+B*clip(N/${fade}\\,0\\,1)'[mix]`,
  `[body][mix]concat=n=2:v=1:a=0,format=yuv420p[out]`,
].join(";");
await run(["-v", "error", "-y", "-i", input, "-filter_complex", filter, ...encode]);

const frames = tail - start;
console.log(`${input}
  skipped ${first} opening frame(s), joined frame ${end} onto frame ${start} with a ${fade}-frame fade
  worst blended pair ${best.worst.toFixed(2)} (a normal frame-to-frame step is ${normalStep.toFixed(2)})
  wrote ${output}: ${frames} frames, ${(frames / fps).toFixed(2)} s`);

// ---------------------------------------------------------------------------

function run(args: string[], allowFailure = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG!, args);
    let text = "";
    child.stderr.on("data", (d) => (text += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 || allowFailure ? resolve(text) : reject(new Error(text))));
  });
}

function runBinary(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG!, args);
    const chunks: Buffer[] = [];
    let errors = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d) => (errors += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(errors))));
  });
}

async function latest(dir: string, pattern: RegExp): Promise<string> {
  const files = (await readdir(dir)).filter((f) => pattern.test(f)).sort();
  if (!files.length) fail(`No file matching ${pattern} in ${dir}/.`);
  return join(dir, files[files.length - 1]);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
