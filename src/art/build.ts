import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createImage, encodePng, setPixel, type Image } from "./png.js";
import { parseSpriteSource, type SpriteSource } from "./source.js";

/**
 * Compiles art/<group>/*.txt into public/art/<group>.png + <group>.json (atlas).
 * Groups: `sprites` (dogs, trainers, props) and `tiles` (scenes).
 */

export const GRID = 16;
export const GROUPS = ["sprites", "tiles"] as const;
export type Group = (typeof GROUPS)[number];

export type Palette = Record<string, string>;
/** sprite → variant → colour remap (palette name → palette name). */
export type Variants = Record<string, Record<string, Record<string, string>>>;

export interface AtlasSprite {
  size: [number, number];
  anchor: [number, number];
  anims: Record<string, { fps: number; frames: [number, number][] }>;
}

export interface Atlas {
  version: 1;
  image: string;
  grid: number;
  palette: Palette;
  sprites: Record<string, AtlasSprite>;
}

export interface BuiltGroup {
  png: Buffer;
  atlas: Atlas;
  image: Image;
  /** Compiled sprites (with variants applied), for validation. */
  sprites: { name: string; source: SpriteSource }[];
}

export function hexToRgba(hex: string): [number, number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

export function loadPalette(artDir: string): Palette {
  const palette = JSON.parse(readFileSync(join(artDir, "palette.json"), "utf8")) as Palette;
  const entries = Object.entries(palette);
  if (entries.length !== 16) throw new Error(`the palette has ${entries.length} colours (there must be 16)`);
  for (const [name, hex] of entries) if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error(`invalid colour ${name}: ${hex}`);
  return palette;
}

export function loadVariants(artDir: string, palette: Palette): Variants {
  let variants: Variants;
  try {
    variants = JSON.parse(readFileSync(join(artDir, "variants.json"), "utf8")) as Variants;
  } catch {
    return {};
  }
  for (const [sprite, byName] of Object.entries(variants)) {
    for (const [variant, remap] of Object.entries(byName)) {
      for (const [from, to] of Object.entries(remap)) {
        if (!(from in palette) || !(to in palette)) throw new Error(`variants.json ${sprite}.${variant}: ${from}→${to} outside the palette`);
      }
    }
  }
  return variants;
}

export function loadSources(artDir: string, group: Group, palette: Palette): SpriteSource[] {
  const dir = join(artDir, group);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort();
  const sprites = files.flatMap((f) => parseSpriteSource(readFileSync(join(dir, f), "utf8"), `art/${group}/${f}`, palette));
  const seen = new Set<string>();
  for (const s of sprites) {
    if (seen.has(s.name)) throw new Error(`sprite "${s.name}" repeated (${s.file})`);
    seen.add(s.name);
  }
  return sprites;
}

function applyVariant(src: SpriteSource, name: string, remap: Record<string, string>): SpriteSource {
  const anims = new Map(
    [...src.anims].map(([k, a]) => [
      k,
      { ...a, frames: a.frames.map((f) => f.map((row) => row.map((c) => (c ? (remap[c] ?? c) : null)))) },
    ]),
  );
  return { ...src, name, anims };
}

export function expandVariants(sources: SpriteSource[], variants: Variants): { name: string; source: SpriteSource }[] {
  return sources.flatMap((src) => {
    const byName = variants[src.variantsOf ?? src.name];
    if (!byName) return [{ name: src.name, source: src }];
    return Object.entries(byName).map(([v, remap]) => ({ name: `${src.name}.${v}`, source: applyVariant(src, `${src.name}.${v}`, remap) }));
  });
}

export function buildGroup(group: Group, sources: SpriteSource[], palette: Palette, variants: Variants): BuiltGroup {
  const sprites = expandVariants(sources, variants);
  const rgba = Object.fromEntries(Object.entries(palette).map(([k, hex]) => [k, hexToRgba(hex)]));

  // One row per sprite; the frames of all its animations from left to right.
  let width = GRID;
  let height = 0;
  const layout = sprites.map(({ source }) => {
    const count = [...source.anims.values()].reduce((n, a) => n + (a.alias ? 0 : a.frames.length), 0);
    width = Math.max(width, count * source.width);
    const y = height;
    height += source.height;
    return y;
  });
  const image = createImage(width, Math.max(height, GRID));
  const atlas: Atlas = { version: 1, image: `${group}.png`, grid: GRID, palette, sprites: {} };

  sprites.forEach(({ name, source }, i) => {
    const y0 = layout[i] ?? 0;
    let x0 = 0;
    const entry: AtlasSprite = { size: [source.width, source.height], anchor: source.anchor, anims: {} };
    for (const [animName, anim] of source.anims) {
      if (anim.alias) continue; // resolved below, once it has a position
      const frames: [number, number][] = [];
      for (const frame of anim.frames) {
        frame.forEach((row, y) =>
          row.forEach((color, x) => {
            if (color) setPixel(image, x0 + x, y0 + y, rgba[color] ?? [255, 0, 255, 255]);
          }),
        );
        frames.push([x0, y0]);
        x0 += source.width;
      }
      entry.anims[animName] = { fps: anim.fps, frames };
    }
    // Alias: same frames as the target animation; the atlas order follows the source.
    const ordered: AtlasSprite["anims"] = {};
    for (const [animName, anim] of source.anims) {
      const target = anim.alias ? entry.anims[anim.alias] : entry.anims[animName];
      if (target) ordered[animName] = { fps: anim.fps, frames: target.frames };
    }
    entry.anims = ordered;
    atlas.sprites[name] = entry;
  });

  return { png: encodePng(image), atlas, image, sprites };
}

export function buildAll(artDir: string): Record<Group, BuiltGroup> {
  const palette = loadPalette(artDir);
  const variants = loadVariants(artDir, palette);
  const out = {} as Record<Group, BuiltGroup>;
  for (const group of GROUPS) out[group] = buildGroup(group, loadSources(artDir, group, palette), palette, variants);
  return out;
}

/** Enlarged strip with every frame of a sprite (to look at the art). */
export function previewStrip(built: BuiltGroup, spriteName: string, scale: number): Buffer {
  const entry = built.atlas.sprites[spriteName];
  if (!entry) throw new Error(`sprite "${spriteName}" does not exist`);
  const frames = Object.values(entry.anims).flatMap((a) => a.frames);
  const [w, h] = entry.size;
  const gap = 2;
  const out = createImage((frames.length * (w + gap) + gap) * scale, (h + gap * 2) * scale);
  // Checkerboard background to show transparency.
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const light = (Math.floor(x / (scale * 2)) + Math.floor(y / (scale * 2))) % 2 === 0;
      setPixel(out, x, y, light ? [200, 200, 200, 255] : [170, 170, 170, 255]);
    }
  frames.forEach(([fx, fy], i) => {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = ((fy + y) * built.image.width + fx + x) * 4;
        const a = built.image.data[p + 3] ?? 0;
        if (!a) continue;
        const px: [number, number, number, number] = [built.image.data[p] ?? 0, built.image.data[p + 1] ?? 0, built.image.data[p + 2] ?? 0, 255];
        const ox = (gap + i * (w + gap) + x) * scale;
        const oy = (gap + y) * scale;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) setPixel(out, ox + dx, oy + dy, px);
      }
  });
  return encodePng(out);
}
