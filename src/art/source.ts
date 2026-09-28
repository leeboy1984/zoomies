/**
 * Text format of the sprites (art/**\/*.txt): character grids with a legend
 * that maps each character to a palette colour (art/palette.json). That way
 * the art is reviewable in git and does not depend on AI.
 *
 *   # comment
 *   sprite dog              sprite name
 *   size 16 16              width and height of each frame (multiples of 16)
 *   anchor 8 15             anchor point (feet), in frame pixels
 *   outline yes             the validator requires an `ink` outline
 *   variants dog.dachshund  uses another sprite's coats (art/variants.json)
 *   legend                  one line per character: <char> <colour|transparent>
 *     . transparent
 *     k ink
 *   anim idle 3             animation and frames per second
 *   anim arrives 6 = runs   alias: reuses the frames of another animation
 *   frame                   followed by `height` lines of `width` characters
 *   ................
 *
 * A legend applies to every following sprite in the same file until another
 * one is declared. A `frame` with no previous `anim` goes to the "default"
 * animation.
 */

export interface Anim {
  fps: number;
  /** If set, the animation reuses this other one's frames (no pixels of its own). */
  alias?: string;
  /** Each frame: rows of colours (palette name or null = transparent). */
  frames: (string | null)[][][];
}

export interface SpriteSource {
  name: string;
  file: string;
  width: number;
  height: number;
  anchor: [number, number];
  outline: boolean;
  /** Takes the coats in art/variants.json from this other sprite. */
  variantsOf?: string;
  anims: Map<string, Anim>;
}

export class SourceError extends Error {
  constructor(file: string, line: number, msg: string) {
    super(`${file}:${line}: ${msg}`);
  }
}

export function parseSpriteSource(text: string, file: string, palette: Record<string, string>): SpriteSource[] {
  const lines = text.split(/\r?\n/);
  const sprites: SpriteSource[] = [];
  let legend = new Map<string, string | null>();
  let current: SpriteSource | null = null;
  let anim: Anim | null = null;

  const fail = (i: number, msg: string): never => {
    throw new SourceError(file, i + 1, msg);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/\s+#.*$/, "");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const [cmd, ...args] = trimmed.split(/\s+/);

    switch (cmd) {
      case "sprite":
        if (!args[0] || !/^[a-z0-9_.-]+$/.test(args[0])) fail(i, "invalid sprite name");
        current = {
          name: args[0] as string,
          file,
          width: 16,
          height: 16,
          anchor: [8, 15],
          outline: false,
          anims: new Map(),
        };
        sprites.push(current);
        anim = null;
        break;
      case "size": {
        if (!current) fail(i, "`size` before `sprite`");
        const [w, h] = args.map(Number);
        if (!w || !h || w % 16 !== 0 || h % 16 !== 0) fail(i, "the size must be a multiple of 16");
        current!.width = w as number;
        current!.height = h as number;
        break;
      }
      case "anchor": {
        if (!current) fail(i, "`anchor` before `sprite`");
        const [x, y] = args.map(Number);
        if (!Number.isInteger(x) || !Number.isInteger(y)) fail(i, "anchor needs two integers");
        current!.anchor = [x as number, y as number];
        break;
      }
      case "outline":
        if (!current) fail(i, "`outline` before `sprite`");
        current!.outline = args[0] === "yes";
        break;
      case "variants":
        if (!current) fail(i, "`variants` before `sprite`");
        if (!args[0]) fail(i, "variants <sprite>");
        current!.variantsOf = args[0];
        break;
      case "legend": {
        legend = new Map();
        while (i + 1 < lines.length && /^\s+\S\s+\S+/.test(lines[i + 1] ?? "")) {
          i++;
          const [ch, color] = (lines[i] ?? "").trim().split(/\s+/);
          if (!ch || ch.length !== 1 || !color) fail(i, "invalid legend line");
          if (color !== "transparent" && !(color! in palette)) fail(i, `colour "${color}" is not in the palette`);
          legend.set(ch!, color === "transparent" ? null : color!);
        }
        break;
      }
      case "anim": {
        if (!current) fail(i, "`anim` before `sprite`");
        const fps = Number(args[1] ?? 1);
        if (!args[0] || !(fps > 0)) fail(i, "anim <name> <fps> [= <other>]");
        if (args[2] !== undefined && (args[2] !== "=" || !args[3])) fail(i, "alias: anim <name> <fps> = <other>");
        anim = args[3] ? { fps, frames: [], alias: args[3] } : { fps, frames: [] };
        if (current!.anims.has(args[0] as string)) fail(i, `animation "${args[0]}" repeated`);
        current!.anims.set(args[0] as string, anim);
        break;
      }
      case "frame": {
        if (!current) fail(i, "`frame` before `sprite`");
        if (!anim) {
          anim = { fps: 1, frames: [] };
          current!.anims.set("default", anim);
        }
        if (anim.alias) fail(i, "an alias animation cannot have frames of its own");
        const rows: (string | null)[][] = [];
        for (let r = 0; r < current!.height; r++) {
          i++;
          const row = (lines[i] ?? "").trim();
          if (row.length !== current!.width) fail(i, `row of ${row.length} characters (expected ${current!.width})`);
          rows.push(
            [...row].map((ch) => {
              if (!legend.has(ch)) fail(i, `character "${ch}" has no legend`);
              return legend.get(ch) ?? null;
            }),
          );
        }
        anim.frames.push(rows);
        break;
      }
      default:
        fail(i, `unknown instruction "${cmd}"`);
    }
  }
  for (const sprite of sprites) {
    for (const [name, a] of sprite.anims) {
      if (a.alias) {
        const target = sprite.anims.get(a.alias);
        if (!target || target.alias) throw new SourceError(file, 0, `${sprite.name}/${name}: alias "${a.alias}" is not an animation with frames`);
      } else if (a.frames.length === 0) {
        throw new SourceError(file, 0, `${sprite.name}/${name}: animation without frames`);
      }
    }
  }
  return sprites;
}
