import { hexToRgba, type Palette } from "./build.js";
import { getPixel, type Image } from "./png.js";

/**
 * Normalisation pass for external images (e.g. AI-generated on a magenta
 * background). Turns any PNG into a text grid in the art/ format, which then
 * goes through the same build and validator:
 *
 * 1. Chroma key: magenta (and anything semi-transparent) becomes transparent.
 * 2. Crop to the content.
 * 3. "Majority" nearest-neighbour rescale: each target pixel takes the most
 *    frequent palette colour of its source block, or transparent if less than
 *    half of the block is opaque.
 * 4. Quantisation to the fixed 16-colour palette.
 * 5. Unified 1 px `ink` outline around the silhouette.
 * 6. Centred horizontally and resting at the bottom of a multiple-of-16 canvas.
 */

/** Fixed character per colour for generated grids. */
export const PALETTE_CHARS: Record<string, string> = {
  ink: "k",
  plum: "p",
  bark: "d",
  fur: "f",
  tan: "l",
  cream: "c",
  white: "w",
  leaf_dark: "e",
  leaf: "m",
  grass: "g",
  lime: "i",
  water: "a",
  red: "r",
  gold: "o",
  stone: "s",
  slate: "t",
};

export interface NormalizeOptions {
  width: number;
  height: number;
  palette: Palette;
  /** Ink outline (yes by default). */
  outline?: boolean;
}

export function isChromaKey(r: number, g: number, b: number): boolean {
  return r >= 150 && b >= 150 && g <= 110 && Math.abs(r - b) < 90;
}

export function nearestColor(r: number, g: number, b: number, palette: Palette): string {
  let best = "";
  let bestD = Infinity;
  for (const [name, hex] of Object.entries(palette)) {
    const [pr, pg, pb] = hexToRgba(hex);
    const d = 2 * (r - pr) ** 2 + 4 * (g - pg) ** 2 + 3 * (b - pb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

/** Returns the resulting grid: rows of colour names or null. */
export function normalizeImage(img: Image, opts: NormalizeOptions): (string | null)[][] {
  const { width: W, height: H, palette } = opts;
  if (W % 16 || H % 16) throw new Error("the target size must be a multiple of 16");
  const outline = opts.outline ?? true;
  const margin = outline ? 1 : 0;

  // 1. chroma key → mask and quantised colour per pixel
  const src: (string | null)[] = new Array(img.width * img.height).fill(null);
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const [r, g, b, a] = getPixel(img, x, y);
      if (a < 128 || isChromaKey(r, g, b)) continue;
      src[y * img.width + x] = nearestColor(r, g, b, palette);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  const grid: (string | null)[][] = Array.from({ length: H }, () => new Array<string | null>(W).fill(null));
  if (maxX < 0) return grid;

  // 2-3. crop and majority rescale
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const scale = Math.max(bw / (W - 2 * margin), bh / (H - 2 * margin), 1);
  const tw = Math.max(1, Math.round(bw / scale));
  const th = Math.max(1, Math.round(bh / scale));
  const ox = Math.floor((W - tw) / 2);
  const oy = H - margin - th;
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++) {
      const x0 = minX + Math.floor((tx * bw) / tw);
      const x1 = Math.max(x0 + 1, minX + Math.floor(((tx + 1) * bw) / tw));
      const y0 = minY + Math.floor((ty * bh) / th);
      const y1 = Math.max(y0 + 1, minY + Math.floor(((ty + 1) * bh) / th));
      const votes = new Map<string, number>();
      let opaque = 0;
      let total = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          total++;
          const c = src[y * img.width + x];
          if (!c) continue;
          opaque++;
          votes.set(c, (votes.get(c) ?? 0) + 1);
        }
      if (opaque * 2 < total) continue;
      const winner = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
      const row = grid[oy + ty];
      if (row) row[ox + tx] = winner;
    }

  // 5. outline around the outside
  if (outline) {
    const filled = grid.map((row) => row.map((c) => c !== null && c !== "ink"));
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (grid[y]?.[x] !== null) continue;
        const touches = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dx, dy]) => filled[y + (dy ?? 0)]?.[x + (dx ?? 0)] === true);
        const row = grid[y];
        if (touches && row) row[x] = "ink";
      }
  }
  return grid;
}

/** Serialises a grid as an art/ source (one sprite, one frame). */
export function gridToSource(name: string, grid: (string | null)[][], outline: boolean, note: string): string {
  const used = new Set(grid.flat().filter((c): c is string => c !== null));
  const legend = ["  . transparent", ...[...used].sort().map((c) => `  ${PALETTE_CHARS[c]} ${c}`)];
  const rows = grid.map((row) => row.map((c) => (c ? PALETTE_CHARS[c] : ".")).join(""));
  const w = grid[0]?.length ?? 16;
  return [
    `# ${note}`,
    "legend",
    ...legend,
    "",
    `sprite ${name}`,
    `size ${w} ${grid.length}`,
    `anchor ${Math.floor(w / 2)} ${grid.length - 1}`,
    `outline ${outline ? "yes" : "no"}`,
    "frame",
    ...rows,
    "",
  ].join("\n");
}
