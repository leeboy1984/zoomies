import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGroup, hexToRgba, loadPalette } from "../src/art/build.js";
import { checkArt, checkImagePalette, checkOutline } from "../src/art/check.js";
import { gridToSource, normalizeImage } from "../src/art/normalize.js";
import { createImage, decodePng, encodePng, getPixel, setPixel } from "../src/art/png.js";
import { parseSpriteSource } from "../src/art/source.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const palette = loadPalette(`${ROOT}art`);

describe("repository art", () => {
  it("all of public/art/ passes validation (palette, grid, outline, up to date)", () => {
    expect(checkArt(ROOT)).toEqual([]);
  });
});

describe("png", () => {
  it("RGBA round trip", () => {
    const img = createImage(3, 2);
    setPixel(img, 0, 0, [255, 0, 0, 255]);
    setPixel(img, 2, 1, [1, 2, 3, 128]);
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(3);
    expect(getPixel(back, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(getPixel(back, 2, 1)).toEqual([1, 2, 3, 128]);
    expect(getPixel(back, 1, 0)).toEqual([0, 0, 0, 0]);
  });

  it("reads RGB with all five PNG filters", () => {
    // 2x5 RGB; each row uses a different filter (0..4) with bytes filtered by hand.
    const w = 2;
    const pixels = [
      [10, 20, 30, 40, 50, 60],
      [11, 21, 31, 41, 51, 61],
      [12, 22, 32, 42, 52, 62],
      [13, 23, 33, 43, 53, 63],
      [14, 24, 34, 44, 54, 64],
    ];
    const paeth = (a: number, b: number, c: number) => {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    const rows: number[] = [];
    pixels.forEach((row, y) => {
      const prev = pixels[y - 1] ?? new Array(6).fill(0);
      rows.push(y);
      row.forEach((v, x) => {
        const a = x >= 3 ? (row[x - 3] ?? 0) : 0;
        const b = prev[x] ?? 0;
        const c = x >= 3 ? (prev[x - 3] ?? 0) : 0;
        const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][y] ?? 0;
        rows.push((v - pred + 256) & 255);
      });
    });
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]); // CRC is not checked when reading
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(5, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(Buffer.from(rows))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    const img = decodePng(png);
    pixels.forEach((row, y) => {
      expect(getPixel(img, 0, y)).toEqual([row[0], row[1], row[2], 255]);
      expect(getPixel(img, 1, y)).toEqual([row[3], row[4], row[5], 255]);
    });
  });
});

describe("text sources", () => {
  const head = "legend\n  . transparent\n  k ink\nsprite x\nsize 16 16\nframe\n";
  const row = "k".repeat(16) + "\n";

  it("rejects rows of the wrong width, characters without a legend and colours outside the palette", () => {
    expect(() => parseSpriteSource(head + "kkk\n", "a.txt", palette)).toThrow(/a\.txt:7: row of 3/);
    expect(() => parseSpriteSource(head + "z".repeat(16) + "\n", "a.txt", palette)).toThrow(/has no legend/);
    expect(() => parseSpriteSource("legend\n  q magenta\n", "a.txt", palette)).toThrow(/is not in the palette/);
    expect(() => parseSpriteSource("sprite x\nsize 10 16\n", "a.txt", palette)).toThrow(/multiple of 16/);
  });

  it("compiles and applies colour variants", () => {
    const [src] = parseSpriteSource(head + row.repeat(16), "a.txt", palette);
    const g = buildGroup("sprites", [src!], palette, { x: { a: {}, b: { ink: "red" } } });
    expect(Object.keys(g.atlas.sprites)).toEqual(["x.a", "x.b"]);
    const [bx, by] = g.atlas.sprites["x.b"]!.anims.default!.frames[0]!;
    expect(getPixel(g.image, bx, by)).toEqual(hexToRgba(palette.red!));
  });
});

describe("validator", () => {
  it("detects colours outside the palette and semi-transparency", () => {
    const img = createImage(16, 16);
    setPixel(img, 0, 0, [255, 0, 255, 255]);
    setPixel(img, 1, 0, [...hexToRgba(palette.ink!).slice(0, 3), 100] as [number, number, number, number]);
    const errors = checkImagePalette(img, palette, "t");
    expect(errors.join("\n")).toMatch(/outside the palette/);
    expect(errors.join("\n")).toMatch(/semi-transparent/);
  });

  it("detects edge pixels without an outline", () => {
    const img = createImage(16, 16);
    setPixel(img, 5, 5, hexToRgba(palette.red!));
    expect(checkOutline(img, 0, 0, 16, 16, palette.ink!, "t")).toHaveLength(1);
    setPixel(img, 5, 5, hexToRgba(palette.ink!));
    expect(checkOutline(img, 0, 0, 16, 16, palette.ink!, "t")).toEqual([]);
  });
});

describe("external image normalisation", () => {
  // "AI-style" image: 200x200, magenta background, red circle with an anti-aliased edge and a highlight.
  const ai = createImage(200, 200);
  for (let y = 0; y < 200; y++)
    for (let x = 0; x < 200; x++) {
      const d = Math.hypot(x - 100, y - 110);
      if (d < 70) setPixel(ai, x, y, [205 + (x % 3), 70, 60, 255]);
      else if (d < 73) setPixel(ai, x, y, [230, 60, 150, 255]); // pink anti-aliasing halo
      else setPixel(ai, x, y, [255, 0, 255, 255]);
      if (Math.hypot(x - 75, y - 85) < 10) setPixel(ai, x, y, [250, 248, 240, 255]);
    }

  const grid = normalizeImage(ai, { width: 16, height: 16, palette });

  it("returns a grid of the requested size, using only palette colours", () => {
    expect(grid).toHaveLength(16);
    expect(grid.every((r) => r.length === 16)).toBe(true);
    const used = new Set(grid.flat().filter(Boolean));
    expect([...used].every((c) => c! in palette)).toBe(true);
    expect(used.has("red")).toBe(true);
    expect(used.has("white")).toBe(true);
  });

  it("removes the magenta, rests the object at the bottom and adds a valid outline", () => {
    // The corners were magenta: now transparent. The silhouette reaches the bottom edge with an outline.
    for (const [x, y] of [[0, 0], [15, 0], [0, 15], [15, 15]]) expect(grid[y!]![x!]).toBeNull();
    expect(grid[15]!.some((c) => c === "ink")).toBe(true);
    const img = createImage(16, 16);
    grid.forEach((row, y) => row.forEach((c, x) => c && setPixel(img, x, y, hexToRgba(palette[c]!))));
    expect(checkImagePalette(img, palette, "n")).toEqual([]);
    expect(checkOutline(img, 0, 0, 16, 16, palette.ink!, "n")).toEqual([]);
  });

  it("generates a text source the parser accepts", () => {
    const text = gridToSource("prop.test", grid, true, "test");
    const [src] = parseSpriteSource(text, "gen.txt", palette);
    expect(src?.name).toBe("prop.test");
    expect(src?.outline).toBe(true);
  });
});

describe("server and art consistency", () => {
  it("every breed and coat exists as an adult (dog.) and a puppy (pup.), with every state and the terrain animations", async () => {
    const { BREEDS, BREED_COATS, DOG_TERRAIN_ANIMS, PUPPY_STATES } = await import("../src/mapping/table.js");
    const { readFileSync } = await import("node:fs");
    const atlas = JSON.parse(readFileSync(`${ROOT}public/art/sprites.json`, "utf8"));
    const expected = BREEDS.flatMap((b) => BREED_COATS[b].flatMap((c) => [`dog.${b}.${c}`, `pup.${b}.${c}`]));
    const inAtlas = Object.keys(atlas.sprites).filter((n) => n.startsWith("dog.") || n.startsWith("pup."));
    expect(inAtlas.sort()).toEqual([...expected].sort());
    const anims = [...PUPPY_STATES, ...DOG_TERRAIN_ANIMS].sort();
    for (const name of expected) expect(Object.keys(atlas.sprites[name].anims).sort()).toEqual(anims);
  });

  it("every trainer (style × skin) has exactly the table states plus the bar and throwing poses", async () => {
    const { TRAINER_UI_ANIMS, TRAINER_STATES, TRAINER_STYLES, TRAINER_SKINS } = await import("../src/mapping/table.js");
    const { readFileSync } = await import("node:fs");
    const atlas = JSON.parse(readFileSync(`${ROOT}public/art/sprites.json`, "utf8"));
    const expected = TRAINER_STYLES.flatMap((st) => TRAINER_SKINS.map((sk) => `trainer.${st}.${sk}`));
    expect(Object.keys(atlas.sprites).filter((n) => n.startsWith("trainer.")).sort()).toEqual([...expected].sort());
    for (const name of expected) {
      expect(atlas.sprites[name].size).toEqual([16, 32]);
      expect(Object.keys(atlas.sprites[name].anims).sort()).toEqual([...TRAINER_STATES, ...TRAINER_UI_ANIMS].sort());
    }
  });

  it("every scene has its compiled map", async () => {
    const { SCENARIOS } = await import("../src/mapping/table.js");
    const { existsSync } = await import("node:fs");
    for (const s of SCENARIOS) expect(existsSync(`${ROOT}public/art/maps/${s}.json`), s).toBe(true);
  });
});
