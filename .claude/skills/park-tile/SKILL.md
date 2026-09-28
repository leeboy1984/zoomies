---
name: park-tile
description: Create or modify Dog Park 16×16 tiles and scene maps (park, forest, agility, beach, square, snow) in art/tiles/ and art/maps/, with the generate → view → validate → clean up → register loop. Use it to add a tile (water, sand, agility obstacles…) or design a map.
---

# Scene tiles and maps

Scenes are built from **16×16 tiles**, never from whole painted backgrounds.
Tiles are text grids in `art/tiles/<tileset>.txt` and every scene is a JSON map
in `art/maps/<name>.json`. Read `STYLE.md` first. All paths are relative to
the repository root.

## Quick rules

- Tile = `sprite <tileset>.<name>`, `size 16 16`, `anchor 0 0`.
- Ground (grass, path, sand, water): opaque, no outline, tiling seamlessly on
  all four sides (no visible edges when repeated).
- Objects (fence, bush, tree, hoop, tunnel, slalom, hurdle): transparent
  around them, `outline yes`. If they are taller than 16 px, split them into
  several tiles (like `tree_top` and `tree_bottom`).
- Transitions between grounds: edge tiles (`path_n`, `path_s`…) with a fringe
  of the neighbouring ground, not colour blends.
- Variety comes from 2 or 3 variants of the same ground scattered by hash, not
  from regular patterns.
- Gameplay: tiles in the `objects` layer block walking; `water` blocks it on
  the ground layer. `tree_bottom`, `pine_bottom`, `palm_bottom`,
  `lamp_bottom`, `bin` and `flag` can be marked by dogs (`MARKABLE` in
  `public/js/model.js`). `paving` is city ground where dogs never dig.

## Loop

1. **Generate**: add the tile's block to `art/tiles/<tileset>.txt`. For a map,
   copy `art/maps/park.json`: `legend` (character → tile name or `null`),
   `layers` (`ground` and `objects`, rows of characters `width` columns wide
   and `height` rows high) and `spots` (tile positions of the trainer,
   companion, bed, puppies and props; in agility also `obstacles`: the
   position of each obstacle in course order).
2. **View**: `npm run build && node bin/zoomies.mjs art preview <tileset>.<tile> tmp/tile.png --scale 10`
   and open it with Read. To see the whole map, start
   `node bin/zoomies.mjs serve` and open `http://127.0.0.1:3737/art-preview.html`
   (`?map=park`, `?map=forest`, `?map=agility`, …; a new map is added to the
   map list in `public/js/art-preview.js` and to `WORLD.zones` in
   `public/js/model.js`).
3. **Validate**: `node bin/zoomies.mjs art build && node bin/zoomies.mjs art check`.
   The build rejects maps with missing tiles, rows of the wrong length or
   spots outside the map.
4. **Clean up**: repeat the tile 3×3 (or look at it on the map) and fix seams
   and noticeable patterns. Check that dogs (16×16) read well on top of the
   ground.
5. **Register**: `art build` updates `public/art/tiles.png`, `tiles.json` and
   `public/art/maps/`. Show a screenshot to the person before calling it done.
