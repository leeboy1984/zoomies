// Sprite provider: the only piece of the frontend that knows about atlases and PNGs.
// To change the art, just replace public/art/ (same atlas format, see
// STYLE.md); the drawing logic does not change.

/** @typedef {{ size: [number, number], anchor: [number, number], anims: Record<string, { fps: number, frames: [number, number][] }> }} AtlasSprite */

async function loadGroup(base, group) {
  const res = await fetch(`${base}/${group}.json`);
  if (!res.ok) throw new Error(`could not load ${group}.json`);
  const atlas = await res.json();
  const image = new Image();
  image.src = `${base}/${atlas.image}`;
  await image.decode();
  return { atlas, image };
}

export class SpriteProvider {
  constructor(groups) {
    /** @type {{ atlas: { sprites: Record<string, AtlasSprite> }, image: HTMLImageElement }[]} */
    this.groups = groups;
  }

  /** @returns {{ image: HTMLImageElement, sprite: AtlasSprite } | null} */
  lookup(name) {
    for (const g of this.groups) {
      const sprite = g.atlas.sprites[name];
      if (sprite) return { image: g.image, sprite };
    }
    return null;
  }

  has(name) {
    return this.lookup(name) !== null;
  }

  /**
   * Draws the frame due at time `t` (ms) with its anchor point at (x, y). If
   * the animation does not exist, falls back to "idle" and then "default".
   * Returns false if the sprite does not exist (to draw a stand-in).
   */
  draw(ctx, name, anim, t, x, y, { flip = false, scale = 1 } = {}) {
    const found = this.lookup(name);
    if (!found) return false;
    const { image, sprite } = found;
    const a = sprite.anims[anim] ?? sprite.anims.idle ?? sprite.anims.default ?? Object.values(sprite.anims)[0];
    if (!a) return false;
    const i = Math.floor((t / 1000) * a.fps) % a.frames.length;
    const [sx, sy] = a.frames[i];
    const [w, h] = sprite.size;
    const [ax, ay] = sprite.anchor;
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(image, sx, sy, w, h, -ax * scale, -ay * scale, w * scale, h * scale);
    ctx.restore();
    return true;
  }
}

export async function createSpriteProvider(base = "/art") {
  return new SpriteProvider(await Promise.all([loadGroup(base, "sprites"), loadGroup(base, "tiles")]));
}

export async function loadMap(name, base = "/art") {
  const res = await fetch(`${base}/maps/${name}.json`);
  if (!res.ok) throw new Error(`could not load map ${name}`);
  return res.json();
}

/** Draws every layer of the map. Tiles are anchored at (0, 0). */
export function drawMap(ctx, provider, map, scale) {
  const size = map.tileSize * scale;
  for (const layer of map.layers) {
    layer.rows.forEach((row, ty) => {
      [...row].forEach((ch, tx) => {
        const tile = map.legend[ch];
        if (tile) provider.draw(ctx, `${map.tileset}.${tile}`, "default", 0, tx * size, ty * size, { scale });
      });
    });
  }
}
