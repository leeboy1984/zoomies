---
name: dog-sprite
description: Create or modify Dog Park dog and trainer sprites (companion, puppies, breeds, coats and animation states) as text grids in art/sprites/, with the generate → view → validate → clean up → register loop. Use it to add a state (e.g. "digs", "sleeps"), a breed, or to touch up the base dog.
---

# Dog sprites

Every breed has its own silhouette in `art/sprites/dog-<breed>.txt` (text
grids, format in `src/art/source.ts`) and every coat is a colour remap of that
breed in `art/variants.json`. The final sprite is called
`dog.<breed>.<coat>`. **No AI image generation is used for dogs.** Read
`STYLE.md` first (sizes, palette, outline, light). All paths are relative to
the repository root.

## Quick rules

- 16×16 frame, anchor `8 15` (feet), profile facing **right**.
- Only characters from the file's legend; the colours come from
  `art/palette.json`.
- 1 px `ink` outline around the whole silhouette (`outline yes`); no loose
  pixels (effects such as drops are drawn by the engine).
- Light from the top left: top row of the back in `tan`, belly in `bark`,
  chest and snout in `cream`, far legs in `bark`.
- 1 to 4 frames per animation. Animation names = the states in
  `src/mapping/table.ts` (`idle`, `runs`, `asks`, `reads`, `sniffs`, `digs`,
  `fetches`, `agility`, `sad`, `shakes`, `celebrates`, `sleeps`, `arrives`,
  `alert`, `leaves`, plus `dashes_off` and `returns` for puppies) and the
  terrain animations in `DOG_TERRAIN_ANIMS` (`pees`, `jumps`).

## Loop

1. **Generate**: add or edit an `anim <state> <fps>` block with its `frame`s
   in `art/sprites/dog-<breed>.txt`. Start from an existing frame (for example
   `idle`) and change only what moves, so you do not drift from the base
   design. **A new animation is drawn for every breed** (a test requires them
   all to have the same animations).
2. **View**: `npm run build && node bin/zoomies.mjs art preview dog.dachshund.red tmp/dog.png --scale 10`
   and open `tmp/dog.png` (with the Read tool, which shows images). Also look
   at another coat (`dog.dachshund.black_tan`) to check the remap works with
   the new frame.
3. **Validate**: `node bin/zoomies.mjs art build && node bin/zoomies.mjs art check`.
   Fix everything it reports (colours, row width, outline).
4. **Clean up**: check by eye what the validator cannot see: light from the
   top left, a silhouette readable at ×3, no stray pixels or odd "staircases",
   and the dog not changing size between frames unless the state calls for it.
5. **Register**: `art build` updates `public/art/sprites.png` and
   `sprites.json` (the atlas). If the animation is new, check it on the test
   page: `node bin/zoomies.mjs serve` and open
   `http://127.0.0.1:3737/art-preview.html`. Show the result to the person
   before calling the animation done.

## New breeds and coats

- **New coat**: add an entry under `dog.<breed>` in `art/variants.json` with
  the `base colour → new colour` remap (palette names only; the base colours
  are in the breed file's legend) and add it to `BREED_COATS` in
  `src/mapping/table.ts`.
- **New breed**: create `art/sprites/dog-<breed>.txt` with `sprite dog.<breed>`,
  the same animations as the other breeds and the common legend (`f l d c w s
  t r`), add at least one coat in `art/variants.json` and register it in
  `BREEDS` and `BREED_COATS` (and, if relevant, `BREEDS_BY_AGENT_TYPE` or
  `OTHER_BREEDS`) in `src/mapping/table.ts`. Add it to `BREEDS` in
  `public/js/art-preview.js` too, to see it on the test page. Add its mouth
  position (running and sitting) to `MOUTH` in `public/js/model.js` so toys
  sit in its mouth.
- Then: `art build`, `art check` and `npm test` (it checks that the atlas and
  the table match).

## Trainer

Same loop with `art/sprites/trainer.txt` (16×32, anchor `8 31`). Its
animations must be exactly `TRAINER_STATES` plus `TRAINER_UI_ANIMS` from
`src/mapping/table.ts` (a test checks it). Look at it with
`node bin/zoomies.mjs art preview trainer.cap.medium tmp/trainer.png --scale 6`.
