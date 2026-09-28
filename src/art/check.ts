import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAll, GRID, GROUPS, hexToRgba, loadPalette, type Atlas } from "./build.js";
import { validateMap } from "./maps.js";
import { decodePng, getPixel, type Image } from "./png.js";

/**
 * Art validator. Checks that everything in public/art/:
 * - is up to date with art/ (rebuilt in memory and compared byte by byte);
 * - only uses the 16 palette colours, with no semi-transparency;
 * - has dimensions and frames aligned to the 16 px grid;
 * - keeps the `ink` outline on sprites marked `outline yes`;
 * and that STYLE.md documents the same palette as art/palette.json.
 */

export function checkImagePalette(img: Image, palette: Record<string, string>, label: string): string[] {
  const allowed = new Set(Object.values(palette).map((hex) => hexToRgba(hex).slice(0, 3).join(",")));
  const errors: string[] = [];
  const bad = new Map<string, number>();
  let semi = 0;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const [r, g, b, a] = getPixel(img, x, y);
      if (a === 0) continue;
      if (a !== 255) semi++;
      const key = `${r},${g},${b}`;
      if (!allowed.has(key)) bad.set(key, (bad.get(key) ?? 0) + 1);
    }
  if (semi) errors.push(`${label}: ${semi} semi-transparent pixels (only alpha 0 or 255 is allowed)`);
  for (const [rgb, n] of bad) errors.push(`${label}: colour rgb(${rgb}) outside the palette (${n} pixels)`);
  if (img.width % GRID || img.height % GRID) errors.push(`${label}: ${img.width}x${img.height} is not a multiple of ${GRID}`);
  return errors;
}

/** Every opaque pixel touching a transparent pixel of the same frame must be `ink`. */
export function checkOutline(img: Image, x0: number, y0: number, w: number, h: number, inkHex: string, label: string): string[] {
  const [ir, ig, ib] = hexToRgba(inkHex);
  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && getPixel(img, x0 + x, y0 + y)[3] === 255;
  let count = 0;
  let first = "";
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!opaque(x, y)) continue;
      const edge = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dx, dy]) => {
        const nx = x + (dx ?? 0);
        const ny = y + (dy ?? 0);
        return nx >= 0 && ny >= 0 && nx < w && ny < h && !opaque(nx, ny);
      });
      const [r, g, b] = getPixel(img, x0 + x, y0 + y);
      if (edge && (r !== ir || g !== ig || b !== ib)) {
        count++;
        first ||= `(${x},${y})`;
      }
    }
  return count ? [`${label}: ${count} edge pixels without an ink outline, the first at ${first}`] : [];
}

function checkAtlasLayout(atlas: Atlas, img: Image, file: string): string[] {
  const errors: string[] = [];
  for (const [name, sprite] of Object.entries(atlas.sprites)) {
    const [w, h] = sprite.size;
    for (const [anim, a] of Object.entries(sprite.anims)) {
      a.frames.forEach(([x, y], i) => {
        if (x % GRID || y % GRID) errors.push(`${file} ${name}/${anim}[${i}]: frame not aligned to the grid`);
        if (x + w > img.width || y + h > img.height) errors.push(`${file} ${name}/${anim}[${i}]: frame outside the image`);
      });
    }
  }
  return errors;
}

export function checkArt(root: string): string[] {
  const artDir = join(root, "art");
  const outDir = join(root, "public", "art");
  const errors: string[] = [];

  let built: ReturnType<typeof buildAll>;
  try {
    built = buildAll(artDir);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  const palette = loadPalette(artDir);

  // STYLE.md must document exactly this palette.
  const style = existsSync(join(root, "STYLE.md")) ? readFileSync(join(root, "STYLE.md"), "utf8").toLowerCase() : "";
  if (!style) errors.push("STYLE.md is missing");
  for (const [name, hex] of Object.entries(palette)) {
    if (style && !(style.includes(hex) && style.includes(`\`${name}\``))) errors.push(`STYLE.md does not document the colour \`${name}\` ${hex}`);
  }

  for (const group of GROUPS) {
    const g = built[group];
    const pngPath = join(outDir, `${group}.png`);
    const jsonPath = join(outDir, `${group}.json`);
    if (!existsSync(pngPath) || !existsSync(jsonPath)) {
      errors.push(`public/art/${group}.png/.json is missing: run \`zoomies art build\``);
      continue;
    }
    const png = readFileSync(pngPath);
    if (!png.equals(g.png) || readFileSync(jsonPath, "utf8") !== JSON.stringify(g.atlas, null, 2) + "\n") {
      errors.push(`public/art/${group} is not up to date with art/: run \`zoomies art build\``);
    }
    const img = decodePng(png);
    errors.push(...checkImagePalette(img, palette, `public/art/${group}.png`));
    const atlas = JSON.parse(readFileSync(jsonPath, "utf8")) as Atlas;
    errors.push(...checkAtlasLayout(atlas, img, `public/art/${group}.json`));
    for (const { name, source } of g.sprites) {
      if (!source.outline) continue;
      const entry = atlas.sprites[name];
      if (!entry) continue;
      for (const [anim, a] of Object.entries(entry.anims)) {
        a.frames.forEach(([x, y], i) => {
          errors.push(...checkOutline(img, x, y, entry.size[0], entry.size[1], palette.ink ?? "#000000", `${name}/${anim}[${i}]`));
        });
      }
    }
  }

  const mapsDir = join(artDir, "maps");
  for (const f of existsSync(mapsDir) ? readdirSync(mapsDir).filter((f) => f.endsWith(".json")) : []) {
    const text = readFileSync(join(mapsDir, f), "utf8");
    errors.push(...validateMap(JSON.parse(text), built.tiles.atlas, built.sprites.atlas).map((e) => `art/maps/${f}: ${e}`));
    const out = join(outDir, "maps", f);
    if (!existsSync(out) || readFileSync(out, "utf8") !== JSON.stringify(JSON.parse(text), null, 2) + "\n") {
      errors.push(`public/art/maps/${f} is not up to date: run \`zoomies art build\``);
    }
  }
  return errors;
}
