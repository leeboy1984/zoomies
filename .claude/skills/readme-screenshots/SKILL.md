---
name: readme-screenshots
description: Add or regenerate the Dog Park README screenshots (docs/img/) with headless Chrome. Use it whenever a change is visible to someone watching the park, and always for a new visible feature, which gets its own image in the README before its pull request. Capture → look → pick → compose → show loop.
---

# README screenshots

The README is how people discover what zoomies does, so **every visible
feature gets its own screenshot**, and every visible change keeps the existing
ones true. Images are never taken by hand: they come from a scripted recording
(`scripts/screenshots/scenario.mjs`) replayed into a throwaway server and
headless Chrome by `scripts/screenshots/run.mjs`, so anyone can regenerate them.
All paths are relative to the repository root.

## When

- **A new visible feature** (a view, a mode, an animation, an action on the
  terrain…): add a new image and a short paragraph for it in the README,
  next to the others at the top or in its section. Do it in the same branch,
  before opening the pull request.
- **A change to something already shown** (art, layout, a behaviour that
  appears in an image): regenerate the images it affects and check that the
  moments they show are still right.
- Not needed for changes nobody can see (server, installer, docs only).

## Quick rules

- `scripts/screenshots/shots.json` has two parts:
  - `runs`: recordings to capture. Each one has `burst` (`[from, to, step]`
    in seconds of the replay) and, optionally, `clockShiftMin` (moves the page
    clock forward, e.g. for the bar), `viewport` (`{ "width", "height" }`,
    3700×1620 by default: the whole park at ×3) and `query` (the page URL,
    `?view=world` by default; e.g. `?fullscreen=1&view=scenes`).
  - `images`: each `docs/img/<name>.png` is one or more `tiles`, each a
    `run`, a time `t` and a `crop` (`[x, y, w, h]` of the frame), laid out in
    `cols` columns with a `gap`.
- If the scenario never shows the situation you need (a tool, a platform, a
  state), add it to `scripts/screenshots/scenario.mjs` rather than faking it.
- Frames are 1:1 CSS pixels; keep images reasonably small (crop to what
  matters, or use a 1920×1080 viewport for "whole screen" shots).
- Alt text says what the image shows, not "screenshot".

## Loop

1. **Capture**: `npm run build`, then
   `npm run screenshots -- --burst --only <run>[,<run>…]` for the runs you
   added or that your change affects (without `--only`, every run is
   captured again). Frames land in `tmp/screenshots/burst-<run>/tNNN.N.png`.
2. **Look**: open several frames with Read and pick the moment that tells the
   story (the toy in the air, the dog in the hoop, a bubble readable…). Two
   runs never look exactly alike (movement follows the browser's real frame
   timing), so always pick from the burst you are going to compose from.
   Tip: to scan many moments at once, temporarily add an image to `shots.json`
   whose tiles are the same crop at many times (`cols` 4–6), compose, look,
   then remove it (and the file it wrote).
3. **Pick**: write the times (and crops) into `shots.json`.
4. **Compose**: `npm run screenshots -- --compose` writes every
   `docs/img/*.png` from the existing bursts. Images from runs you did not
   capture again come out identical; check `git status` to be sure only the
   images you meant changed.
5. **Show**: open the composed images with Read, add or update them in the
   `README.md` (and the paragraph that explains them), and show them to the
   person before calling it done. Mention them in the pull request checklist.
