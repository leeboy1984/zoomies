# Art style guide (Dog Park)

Every asset in `public/art/` comes from `art/` through `zoomies art build`, and
is validated by `zoomies art check` (also part of `npm test`). The validator
automatically checks the palette, the grid, the outline and that `public/art/`
is up to date. Light and shading cannot be checked by a script: review them by
eye with `zoomies art preview`.

## Grid and sizes

| Element | Frame size | Notes |
|---|---|---|
| Scene tile | 16×16 | Anchor (0, 0). Trees and tall objects are split across several tiles. |
| Dog (any breed) | 16×16 | Anchored at the feet: (8, 15). |
| Puppy | 16×16 | Same canvas: shorter body and legs 1 px shorter, same head. |
| Trainer (any style) | 16×32 | Anchored at the feet: (8, 31). |
| Prop | 16×16, 32×16 or 48×32 | Anchored at the bottom centre. |
| Toy in the mouth (`toy.*`) | 16×16 | Anchored at the centre: (8, 8). |

- Every frame is a multiple of 16 wide and high; the atlas places them aligned
  to the 16 px grid.
- On screen everything is scaled by an **integer** (×3 by default), nearest
  neighbour (`imageSmoothingEnabled = false`, `image-rendering: pixelated`).
  The only exception: in the scenes view, if a scene does not fit at ×2, it is
  drawn at ×2 and the browser shrinks it to the available width.
- No anti-aliasing, semi-transparency or gradients. Alpha is only 0 or 255.

## Palette (16 colours, fixed)

Defined in `art/palette.json`. The validator rejects any other colour and
checks that this table matches the JSON.

| Name | Hex | Main use |
|---|---|---|
| `ink` | #1f1a24 | Outline, eyes, nose |
| `plum` | #4a3548 | Deep shadow, dark fur (border collie) |
| `bark` | #6e4b36 | Brown shadow, tree trunks, ears |
| `fur` | #a86f45 | Base fur, wood |
| `tan` | #d9a066 | Brown highlight, path dirt |
| `cream` | #f2dfb4 | Chest and snout, pebbles, cushion |
| `white` | #fbf7ef | Highlights, bone, bubbles |
| `leaf_dark` | #2e5a3a | Vegetation shadow |
| `leaf` | #4e8a3e | Mid vegetation, grass tufts |
| `grass` | #7fb24a | Base grass |
| `lime` | #b8d86b | Vegetation highlight |
| `water` | #3f78a8 | Water |
| `red` | #c8483f | Collar, ball, bed, flowers |
| `gold` | #f0c04a | Flowers, ball stripe, beer |
| `stone` | #8a8691 | Stone, grey fur |
| `slate` | #54505e | Stone shadow, dark fur |

Ramps (dark to light) for shading:

- Brown: `bark` → `fur` → `tan` → `cream`
- Green: `leaf_dark` → `leaf` → `grass` → `lime`
- Grey: `slate` → `stone` → `white`

## Outline

- 1 px of `ink` **outside** the silhouette on dogs, trainers, props and scene
  objects (`outline yes` in the source; the validator requires every opaque
  pixel touching a transparent one to be `ink`).
- Ground tiles (grass, path, water) have no outline.
- `ink` lines are allowed inside the silhouette (eyes, nose, gaps between legs).
- Loose pixels (drops, sparks) are not allowed inside a sprite: effects like
  the pee stream are drawn by the engine.

## Light and shadows

- Light from the **top left**: top and left edges use the light tone of the
  ramp; bottom and right, the dark one.
- Far legs are one tone darker than near ones.
- **Ground shadows are not painted into the sprite**: the engine draws them as
  a flat, translucent `ink` ellipse under the feet. It is the only translucent
  element, and it only exists at runtime.

## Orientation and animation

- Characters are drawn in profile facing **right**; left is obtained by
  mirroring. Only 2 directions.
- 1 to 4 frames per animation. The fps go in the source (`anim <name> <fps>`).
- Dog states (every breed, adult and puppy), 2 or 3 frames: `idle`, `alert`
  (head up, ear up), `reads` (lying down with a sheet of paper), `sniffs`
  (snout to the ground), `digs` (dirt flying back and a little mound), `runs`,
  `fetches` (ball in the mouth), `agility` (leap), `sad` (head and tail down),
  `asks` (sitting: front legs straight, hind legs tucked, wagging tail),
  `shakes` (water drops), `celebrates` (little hop), `sleeps` (lying down, eyes
  closed, breathing) and `returns` (with a bone in the mouth). `arrives`,
  `leaves` and `dashes_off` are aliases of `runs` at another speed
  (`anim arrives 6 = runs`), with no pixels of their own.
- Terrain animations (the UI picks them, they are not states): `pees` (hind leg
  lifted backwards; the engine draws the stream) and `jumps` (stretched out in
  mid-air; the engine adds the arc).
- Puppies (`pup.<breed>`): same animations as the adult; they use the adult's
  coats through `variants dog.<breed>`.
- Trainers (`art/sprites/trainer.txt`): 5 styles with their own silhouette and
  clothes (`cap`, wool `beanie` with a pompom, `long_hair`, straw `hat` and
  `ponytail`) × 4 skin tones in `art/variants.json` (`light`, `medium`,
  `brown`, `dark`) = `trainer.<style>.<skin>`. The face fills the head (eye,
  eyebrow, nose, mouth and ear); hair only goes behind or on top.
  8 states of 2 frames: `enters` and `leaves` (walking), `idle`, `notebook`,
  `stopwatch` (wrist raised to the chin, glancing at the watch), `whistles`,
  `points` (arm above the head) and `celebrates`.
  Plus the poses the UI picks: `sits` and `drinks` (seated at the bar with a
  beer), `stands` and `stands_drinking` (standing at the counter), `winds_up`
  (arm back behind the head, toy in hand) and `throws` (arm stretched forward).
  All styles share the same body, so these poses are built from each style's
  head.

## Breeds and coats

- Every **breed** is its own silhouette in `art/sprites/dog-<breed>.txt`:
  `dachshund` (long body, short legs, long snout), `beagle` (tricolour hound,
  long ears), `border_collie` (semi-erect ears, low bushy tail, white face,
  chest and paws), `pug` (compact, round head, dark mask, curly tail) and
  `mutt`.
- Every **coat** is a colour remap of its breed in `art/variants.json`. The
  resulting sprite is called `dog.<breed>.<coat>` (e.g.
  `dog.dachshund.black_tan`). A new coat does not need redrawing.
- Every breed shares the same base colour legend: `f` fur, `l` highlight, `d`
  shadow, `c` chest and snout, `w` white, `s` dark marking, `t` marking
  highlight, `r` collar.
- Each project's companion is any breed and coat (hashed from its folder, or
  set in `zoomies.config.json`). Puppies use the breed of their subagent type
  and a coat of that breed.

## Scenes

| Tileset | Ground | Objects |
|---|---|---|
| `park` | grass (2), flowers, path with edges | fence, bush, tree (2 tiles) |
| `forest` | dark ground, fallen leaves, trail with edges | pine (2 tiles), log, mushrooms, rock, fern |
| `agility` | grass, sand with edges | white fence, hurdle, hoop, tunnel (2 tiles), slalom, flag |
| `beach` | sand (2), sea with waves, shoreline with foam | umbrella and palm tree (2 tiles), towel, bucket and spade, sandcastle |
| `square` | paving (2), lawn with edges | fountain and lamp post (2 tiles), bench (2 tiles), planter, bin |
| `snow` | snow (2, with footprints), trodden trail with edges | snowy pine (2 tiles), snowman, sledge, snowy rock |

Maps: `art/maps/park.json`, `forest.json`, `agility.json`, `beach.json`,
`square.json` and `snow.json`, all 24×14 tiles with the same `spots` for the
trainer, companion and puppies. Tiles in the `objects` layer cannot be walked
on; trees, lamp posts, bins and flags can be marked.

## Formats

- **Sources** (`art/sprites/*.txt`, `art/tiles/*.txt`): text grids with a
  legend character → palette colour. Full format in `src/art/source.ts`.
- **Maps** (`art/maps/*.json`): layers of character rows + a legend
  character → tile + positions (`spots`) of the trainer, companion, puppies
  and props.
- **Atlas** (`public/art/<group>.json`, next to `<group>.png`):

  ```json
  {
    "version": 1,
    "image": "sprites.png",
    "grid": 16,
    "palette": { "ink": "#1f1a24" },
    "sprites": {
      "dog.dachshund.red": {
        "size": [16, 16],
        "anchor": [8, 15],
        "anims": { "idle": { "fps": 3, "frames": [[0, 0], [16, 0]] } }
      }
    }
  }
  ```

  To replace the art, just keep this format and the sprite and animation
  names; the frontend only talks to the atlas through `public/js/sprites.js`.

## Pipeline

```sh
node bin/zoomies.mjs art build                     # art/ → public/art/
node bin/zoomies.mjs art check                     # full validation
node bin/zoomies.mjs art preview dog.dachshund.red # enlarged strip in tmp/
node bin/zoomies.mjs art normalize input.png --name prop.bench --size 32x16
```

`normalize` is the mandatory pass for any external image (for example,
AI-generated on a magenta background). It removes the magenta, crops,
rescales by nearest neighbour, quantises to the palette, adds the outline and
writes a **text source** into `art/sprites/`. From there the image is just
another sprite: it can be touched up by hand and goes through the same build
and validator.

## Not allowed

- Colours outside the palette, semi-transparency, anti-aliasing.
- Non-integer scaling.
- Logos, brands or text from real products (pet food or care, kennel clubs,
  etc.).
