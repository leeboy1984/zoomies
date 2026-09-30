# Contributing

Thanks for wanting to make the dog park better! This guide covers setup, the
checks every change has to pass and how to update the art and the README
screenshots. If you work with a coding agent, point it at
[`AGENTS.md`](AGENTS.md).

## Setup

Requirements: Node 20 or later. Google Chrome or Chromium only if you want to
regenerate screenshots.

```sh
git clone <your fork>
cd zoomies
npm install          # installs and builds dist/
npm test             # everything should be green before you start
```

Optional but recommended: git hooks with [lefthook](https://lefthook.dev),
which run the quick checks before each commit and the full suite before each
push.

```sh
npx lefthook install
```

## Development loop

```sh
npm run serve        # http://127.0.0.1:3737
npm run demo         # in another terminal: replays examples/demo.jsonl
```

- Frontend changes (`public/`) only need a page reload.
- Server changes (`src/`) need `npm run build` and a server restart (Ctrl+C
  and `npm run serve` again, or `npm restart` if you used `npm start`).
- To watch your own sessions, `node bin/zoomies.mjs install-hooks` in a
  personal project (see the README).

## Checks

Every pull request runs these in CI, so run them locally first:

```sh
npm test             # tsc + vitest: server, mapper, UI logic, art, installer
npm run art:check    # if you touched art/
```

Please add or update tests with every behaviour change. Most UI behaviour
lives in `public/js/model.js` and is tested in `test/ui-model.test.ts` without
a browser; the event mapping is tested case by case in
`test/mapper.test.ts`.

## Ground rules

- **Privacy first.** Raw hook payloads never leave `src/mapping/sanitize.ts`.
  If a feature needs more data from a payload, add the smallest possible
  field to `NormalizedEvent` and never pass file contents, prompts, commands
  in full or tool responses to the state or the browser.
- **The hook forwarder stays silent and fast**: no output, always exit 0, no
  dependencies.
- **Local only**: do not relax the loopback, `Host` or `Origin` checks.
- **English everywhere**: code, comments, UI and docs.

## Art

Art is drawn as text grids in `art/` and compiled into `public/art/` (commit
both). Read [`STYLE.md`](STYLE.md) first: fixed 16-colour palette, 1 px outline,
light from the top left, integer scaling.

```sh
npm run art:build
npm run art:check
node bin/zoomies.mjs art preview dog.dachshund.red tmp/dog.png --scale 10
```

The step-by-step loops for dogs, trainers, tiles, maps and props are in
`.claude/skills/` (usable by any agent or by hand).

## Screenshots

The README images in `docs/img/` are generated from a scripted recording
(`scripts/screenshots/scenario.mjs`) with headless Chrome. **A new visible
feature gets its own image in the README**, and a change visible in the
existing ones regenerates them. A new image is a new entry in `images` (and,
if it needs another screen size or URL, a new run with `viewport` and `query`)
in `scripts/screenshots/shots.json`. The full loop is in
`.claude/skills/readme-screenshots/SKILL.md`.

```sh
npm run build
npm run screenshots -- --burst     # frames into tmp/screenshots/burst-<run>/
                                   # (--only <run>,… captures just those runs)
# look at the frames and pick the moments you like
# edit the times (and crops) in scripts/screenshots/shots.json
npm run screenshots -- --compose   # docs/img/*.png from that same burst
```

Two runs never look exactly alike (movement follows the browser's real frame
timing), which is why the images are composed from the burst you looked at.
The script starts its own server and Chrome on ports 3739 and 9339, so it
never touches your running zoomies or your browser. Set `CHROME_PATH` if Chrome
is not found.

## Pull requests

- Keep them focused; describe what changes for someone watching the park.
- Include screenshots or a short clip for visual changes.
- Fill in the checklist in the PR template.

## License

By contributing you agree that your contributions are licensed under the MIT
license of this project.
