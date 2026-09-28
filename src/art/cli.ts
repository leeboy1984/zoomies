import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAll, GROUPS, loadPalette, previewStrip } from "./build.js";
import { checkArt } from "./check.js";
import { gridToSource, normalizeImage } from "./normalize.js";
import { decodePng } from "./png.js";
import { validateMap } from "./maps.js";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const ART_DIR = join(ROOT, "art");
export const OUT_DIR = join(ROOT, "public", "art");

export const ART_USAGE = `zoomies art <command>

  build                     Compiles art/ into public/art/ (PNG + JSON atlas)
  check                     Validates public/art/ (palette, grid, outline, up to date)
  normalize <input.png> --name <sprite> --size <WxH> [--out f.txt] [--no-outline]
                            Turns an external image (e.g. AI-generated on a
                            magenta background) into an art/ text source
  preview <sprite> [output.png] [--scale N]
                            Enlarged strip with every frame of a sprite
`;

function check(): void {
  const errors = checkArt(ROOT);
  if (errors.length) {
    console.error(`Art has ${errors.length} problem(s):\n  ${errors.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("Art OK: palette, grid, outline and public/art/ up to date.");
}

function normalize(args: string[]): void {
  const input = args[0];
  const val = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const name = val("--name");
  const size = val("--size")?.match(/^(\d+)x(\d+)$/);
  if (!input || !name || !size) throw new Error("usage: zoomies art normalize <input.png> --name prop.bench --size 32x16");
  if (!/^[a-z0-9_.-]+$/.test(name)) throw new Error("invalid sprite name");
  const outline = !args.includes("--no-outline");
  const grid = normalizeImage(decodePng(readFileSync(input)), {
    width: Number(size[1]),
    height: Number(size[2]),
    palette: loadPalette(ART_DIR),
    outline,
  });
  const out = val("--out") ?? join(ART_DIR, "sprites", `${name}.txt`);
  writeFileSync(out, gridToSource(name, grid, outline, `Normalised from an external image (${new Date().toISOString().slice(0, 10)}). Touch it up by hand if needed.`));
  console.log(out);
}

function build(): void {
  const built = buildAll(ART_DIR);
  mkdirSync(OUT_DIR, { recursive: true });
  for (const group of GROUPS) {
    const g = built[group];
    writeFileSync(join(OUT_DIR, `${group}.png`), g.png);
    writeFileSync(join(OUT_DIR, `${group}.json`), JSON.stringify(g.atlas, null, 2) + "\n");
    console.log(`public/art/${group}.png  ${g.image.width}x${g.image.height}  ${Object.keys(g.atlas.sprites).length} sprites`);
  }
  mkdirSync(join(OUT_DIR, "maps"), { recursive: true });
  for (const f of readdirSync(join(ART_DIR, "maps")).filter((f) => f.endsWith(".json"))) {
    const map = JSON.parse(readFileSync(join(ART_DIR, "maps", f), "utf8"));
    const errors = validateMap(map, built.tiles.atlas, built.sprites.atlas);
    if (errors.length) throw new Error(`art/maps/${f}:\n  ${errors.join("\n  ")}`);
    writeFileSync(join(OUT_DIR, "maps", f), JSON.stringify(map, null, 2) + "\n");
    console.log(`public/art/maps/${f}`);
  }
}

function preview(args: string[]): void {
  const name = args[0];
  if (!name) throw new Error("Missing sprite: zoomies art preview dog.beagle");
  const i = args.indexOf("--scale");
  const scale = i >= 0 ? Number(args[i + 1]) : 8;
  const outArg = args.find((a, j) => j > 0 && !a.startsWith("--") && args[j - 1] !== "--scale");
  const out = outArg ?? join(ROOT, "tmp", `preview-${name}.png`);
  const built = buildAll(ART_DIR);
  const group = GROUPS.find((g) => built[g].atlas.sprites[name]);
  if (!group) throw new Error(`sprite "${name}" does not exist`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, previewStrip(built[group], name, scale));
  console.log(out);
}

export async function artMain(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "build":
      return build();
    case "preview":
      return preview(rest);
    case "check":
      return check();
    case "normalize":
      return normalize(rest);
    default:
      console.log(ART_USAGE);
      if (cmd) process.exitCode = 1;
  }
}
