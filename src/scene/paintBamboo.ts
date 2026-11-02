import { seededRandom } from "./wind";

/**
 * Paints an illustrated bamboo grove onto a transparent canvas: shaded culms
 * with nodes, drooping leaf sprays on short twigs. Sizes are given in world
 * units and converted with `pixelsPerUnit`, so every layer shares one scale.
 */
export interface GroveStyle {
  seed: number;
  widthUnits: number;
  heightUnits: number;
  pixelsPerUnit: number;
  stalks: number;
  /** Culm thickness range, world units. */
  thickness: [number, number];
  /** 0..1: how many nodes carry a leaf spray. */
  leafiness: number;
  /** Leaf length range, world units. */
  leafLength: [number, number];
  /** Brightness multiplier: far layers lighter, near layers darker. */
  tone: number;
  /** Stalks crowd toward this edge (0 = left, 1 = right) of the canvas. */
  crowdToward: number;
}

const STALK_HUES = [88, 92, 96, 100, 84];
const LEAF_HUES = [92, 98, 104, 110, 86];

export function paintGrove(style: GroveStyle): HTMLCanvasElement {
  const random = seededRandom(style.seed);
  const k = style.pixelsPerUnit;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(64, Math.round(style.widthUnits * k));
  canvas.height = Math.round(style.heightUnits * k);
  const ctx = canvas.getContext("2d")!;
  const H = canvas.height;
  const W = canvas.width;

  const hsl = (hue: number, sat: number, light: number, alpha = 1) =>
    `hsla(${hue}, ${sat}%, ${Math.max(4, Math.min(92, light * style.tone))}%, ${alpha})`;

  // Back stalks first, so nearer (thicker) ones overlap them.
  const stalks = Array.from({ length: style.stalks }, () => {
    const crowd = Math.pow(random(), 0.7);
    const u = style.crowdToward > 0.5 ? 1 - crowd * 0.92 : crowd * 0.92;
    return {
      x: u * W,
      thickness: (style.thickness[0] + random() * (style.thickness[1] - style.thickness[0])) * k,
      lean: (random() - 0.5) * 0.06 * H,
      hue: STALK_HUES[Math.floor(random() * STALK_HUES.length)],
      light: 30 + random() * 14,
      nodeGap: (0.95 + random() * 0.4) * k,
      nodeOffset: random(),
    };
  }).sort((a, b) => a.thickness - b.thickness);

  for (const stalk of stalks) {
    // Lean grows with height; segments can start just below the canvas, hence the clamp.
    const xAt = (y: number) => stalk.x + stalk.lean * Math.pow(Math.max(0, 1 - y / H), 1.5);
    const half = stalk.thickness / 2;

    // Culm, segment by segment, with a rounded-cylinder shading.
    for (let yTop = H + stalk.nodeGap * stalk.nodeOffset - stalk.nodeGap; yTop > -stalk.nodeGap; yTop -= stalk.nodeGap) {
      const yBottom = yTop + stalk.nodeGap;
      const cx = xAt((yTop + yBottom) / 2);
      const gradient = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
      gradient.addColorStop(0, hsl(stalk.hue, 45, stalk.light * 0.55));
      gradient.addColorStop(0.28, hsl(stalk.hue - 6, 55, stalk.light * 1.45));
      gradient.addColorStop(0.5, hsl(stalk.hue, 50, stalk.light));
      gradient.addColorStop(1, hsl(stalk.hue + 4, 45, stalk.light * 0.45));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(xAt(yTop) - half, yTop);
      ctx.lineTo(xAt(yTop) + half, yTop);
      ctx.lineTo(xAt(yBottom) + half, yBottom);
      ctx.lineTo(xAt(yBottom) - half, yBottom);
      ctx.closePath();
      ctx.fill();

      // Node: a dark joint with a pale, powdery band just above it.
      const nodeX = xAt(yTop);
      ctx.fillStyle = hsl(stalk.hue, 40, stalk.light * 0.45);
      ctx.fillRect(nodeX - half * 1.08, yTop - half * 0.09, half * 2.16, Math.max(1, half * 0.18));
      ctx.fillStyle = `rgba(232, 238, 200, ${0.28 * Math.min(1, style.tone)})`;
      ctx.fillRect(nodeX - half, yTop - half * 0.42, half * 2, Math.max(1, half * 0.22));
    }

    // Leaf sprays on the upper nodes.
    for (let y = H * 0.68; y > -stalk.nodeGap; y -= stalk.nodeGap) {
      if (random() > style.leafiness) continue;
      const side = random() < 0.5 ? -1 : 1;
      const twigLength = (0.15 + random() * 0.35) * k;
      const startX = xAt(y) + side * half;
      const endX = startX + side * twigLength;
      const endY = y - twigLength * 0.25 + random() * twigLength * 0.2;
      ctx.strokeStyle = hsl(stalk.hue, 40, stalk.light * 0.8);
      ctx.lineWidth = Math.max(1, half * 0.15);
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.quadraticCurveTo((startX + endX) / 2, endY - twigLength * 0.15, endX, endY);
      ctx.stroke();

      const leaves = 3 + Math.floor(random() * 4);
      for (let i = 0; i < leaves; i++) {
        const length = (style.leafLength[0] + random() * (style.leafLength[1] - style.leafLength[0])) * k;
        // Drooping, fanned out from the twig tip.
        const angle = side > 0 ? 0.35 + random() * 1.0 : Math.PI - 0.35 - random() * 1.0;
        paintLeaf(ctx, endX, endY, angle, length, LEAF_HUES[Math.floor(random() * LEAF_HUES.length)], 30 + random() * 18, hsl);
      }
    }
  }
  return canvas;
}

function paintLeaf(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  length: number,
  hue: number,
  light: number,
  hsl: (hue: number, sat: number, light: number, alpha?: number) => string,
) {
  const width = length * 0.14;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const gradient = ctx.createLinearGradient(0, 0, length, 0);
  gradient.addColorStop(0, hsl(hue, 50, light * 0.7));
  gradient.addColorStop(0.6, hsl(hue - 4, 58, light * 1.15));
  gradient.addColorStop(1, hsl(hue - 8, 55, light * 1.35));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(length * 0.25, -width, length * 0.7, -width * 0.8, length, 0);
  ctx.bezierCurveTo(length * 0.7, width * 0.55, length * 0.25, width * 0.8, 0, 0);
  ctx.fill();
  // Midrib.
  ctx.strokeStyle = hsl(hue - 10, 45, light * 1.5, 0.55);
  ctx.lineWidth = Math.max(0.6, width * 0.08);
  ctx.beginPath();
  ctx.moveTo(length * 0.05, 0);
  ctx.lineTo(length * 0.92, 0);
  ctx.stroke();
  ctx.restore();
}
