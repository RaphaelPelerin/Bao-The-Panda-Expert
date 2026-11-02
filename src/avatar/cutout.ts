/**
 * Removes the flat studio background from the panda portrait in the browser, so
 * the character can stand inside the 3D jungle. Flood-fills from the image
 * border through background-colored pixels, feathers the edge, then removes
 * the background color that bleeds into the fur ("decontamination").
 */

/** Max color distance from the background average for a pixel to count as background. */
const BG_TOLERANCE = 62;
/** Max color step between neighbors while filling, so soft fur edges are not swallowed. */
const STEP_TOLERANCE = 16;
/** How far the background's dominant color channel must lead the other two. */
const TINT_MARGIN = 4;
const FEATHER_RADIUS = 2;

export async function cutOutBackground(url: string): Promise<HTMLCanvasElement> {
  const image = new Image();
  image.src = url;
  await image.decode();

  const { naturalWidth: width, naturalHeight: height } = image;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, width, height);
  const data = pixels.data;

  const bg = estimateBackground(data, width, height);
  const distance = (i: number, r: number, g: number, b: number) =>
    Math.hypot(data[i] - r, data[i + 1] - g, data[i + 2] - b);
  // Distance alone confuses cream fur with a pale backdrop, so also require
  // the background's dominant channel to stay dominant.
  const dominant = bg.indexOf(Math.max(...bg));
  const others = [0, 1, 2].filter((c) => c !== dominant);
  const sameTint = (i: number) => others.every((c) => data[i + dominant] - data[i + c] > TINT_MARGIN);
  const isBackground = (i: number) => sameTint(i) && distance(i, bg[0], bg[1], bg[2]) < BG_TOLERANCE;

  // 1. Flood fill from the borders: 1 = background.
  const mask = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const seed = (p: number) => {
    if (!mask[p] && isBackground(p * 4)) {
      mask[p] = 1;
      queue[tail++] = p;
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    const y = (p - x) / width;
    const i = p * 4;
    const neighbors = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1];
    for (const n of neighbors) {
      if (n < 0 || mask[n]) continue;
      const j = n * 4;
      if (isBackground(j) && distance(j, data[i], data[i + 1], data[i + 2]) < STEP_TOLERANCE) {
        mask[n] = 1;
        queue[tail++] = n;
      }
    }
  }

  // 2. Alpha = blurred foreground mask, for a soft, fur-friendly edge.
  const alpha = new Float32Array(width * height);
  for (let p = 0; p < alpha.length; p++) alpha[p] = mask[p] ? 0 : 1;
  boxBlur(alpha, width, height, FEATHER_RADIUS);

  // 3. Un-mix the background color from semi-transparent edge pixels.
  for (let p = 0; p < alpha.length; p++) {
    const a = alpha[p];
    const i = p * 4;
    if (a < 0.999 && a > 0.02) {
      for (let c = 0; c < 3; c++) {
        data[i + c] = clamp((data[i + c] - bg[c] * (1 - a)) / a);
      }
    }
    data[i + 3] = Math.round(a * 255);
  }

  context.putImageData(pixels, 0, 0);
  return canvas;
}

/**
 * Average color of patches on the top corners and upper side edges. The bottom
 * corners are skipped: a portrait's shoulders usually touch them.
 */
function estimateBackground(data: Uint8ClampedArray, width: number, height: number): [number, number, number] {
  const patch = Math.max(4, Math.round(width * 0.03));
  const sum = [0, 0, 0];
  let count = 0;
  const sideY = Math.round(height * 0.3);
  for (const [cx, cy] of [
    [0, 0],
    [width - patch, 0],
    [0, sideY],
    [width - patch, sideY],
  ]) {
    for (let y = cy; y < cy + patch; y++) {
      for (let x = cx; x < cx + patch; x++) {
        const i = (y * width + x) * 4;
        sum[0] += data[i];
        sum[1] += data[i + 1];
        sum[2] += data[i + 2];
        count++;
      }
    }
  }
  return [sum[0] / count, sum[1] / count, sum[2] / count];
}

function boxBlur(values: Float32Array, width: number, height: number, radius: number): void {
  const temp = new Float32Array(values.length);
  const size = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += values[y * width + Math.min(width - 1, Math.max(0, x + k))];
      temp[y * width + x] = sum / size;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += temp[Math.min(height - 1, Math.max(0, y + k)) * width + x];
      values[y * width + x] = sum / size;
    }
  }
}

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
