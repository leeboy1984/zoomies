---
name: prop-sprite
description: Create Dog Park props and decoration (bench, ball, bone, bed, toys, bar furniture…) by hand as a text grid or from an AI-generated image, always going through normalisation (grid, 16-colour palette, outline). Generate → view → validate → clean up → register loop.
---

# Props and decoration

Props are `prop.<name>` sprites in `art/sprites/` (toys in the mouth are
`toy.<name>`). They can be drawn by hand (text grid) or start from an
AI-generated image, but **every external image goes through `art normalize`**,
which turns it into a text grid with the palette and outline from `STYLE.md`.
All paths are relative to the repository root.

## Quick rules

- Size 16×16, 32×16 or 48×32 (multiples of 16), anchored at the bottom
  centre, `outline yes`. Toys in the mouth: 16×16 anchored at the centre
  (`anchor 8 8`).
- A new throwable toy needs both a `prop.<name>` (on the ground) and a
  `toy.<name>` (small, in the mouth), plus an entry in `TOYS` in
  `public/js/model.js`.
- No text, logos or real brands.

## Loop

1. **Generate**, in one of two ways:
   - **By hand**: add a `sprite prop.<name>` block to
     `art/sprites/props.txt` (or `toys.txt` / `bar.txt`).
   - **With AI** (only if the person has an image-generation MCP): ask for a
     single isolated object, in profile or 3/4 view, 16-bit pixel-art style,
     no anti-aliasing, on a **flat magenta background #FF00FF**, with no
     background shadows or text. Save the image in `tmp/` (git-ignored), not in
     `public/`.
2. **View**: open the generated image with Read and discard it if it does not
   comply (uneven background, several objects, text, odd perspective). Ask for
   another one before normalising.
3. **Clean up (normalise)**, for external images only:
   `npm run build && node bin/zoomies.mjs art normalize tmp/<image>.png --name prop.<name> --size 32x16`
   It writes `art/sprites/prop.<name>.txt`: removes the magenta, crops,
   rescales by nearest neighbour, quantises to the palette and adds the
   outline. Then touch up the grid by hand if needed (stray pixels, light from
   the top left).
4. **Validate**: `node bin/zoomies.mjs art build && node bin/zoomies.mjs art check`
   and `node bin/zoomies.mjs art preview prop.<name> tmp/prop.png --scale 10`
   (open it with Read).
5. **Register**: `art build` adds it to `public/art/sprites.png` and
   `sprites.json`. If it is placed in a scene, add its position to the map's
   `spots.props` (`art/maps/*.json`). Show the result to the person before
   calling it done.
