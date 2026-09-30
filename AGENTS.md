# AGENTS.md

Guidance for coding agents (Claude Code, Codex, Copilot, …) working on
zoomies. Humans: see [`CONTRIBUTING.md`](CONTRIBUTING.md) and the
[`README`](README.md).

## What this is

A local web app that turns the hook events of coding agents (Claude Code,
Codex, GitHub Copilot CLI) into a pixel-art dog park: each session is a
trainer with a dog, each subagent a puppy. Node 20+,
TypeScript server, framework-free Canvas 2D frontend, art kept as text grids.

## How data flows

```
host hook ─▶ bin/zoomies-hook.cjs [--source codex|copilot] ─▶ POST 127.0.0.1:3737/event
  ─▶ src/mapping/sanitize.ts   (privacy boundary: raw payload → NormalizedEvent)
  ─▶ src/state/store.ts        (per-session state, using src/mapping/table.ts)
  ─▶ WebSocket /ws             (SessionView snapshots)
  ─▶ public/js/model.js        (pure UI logic: layout, movement, actions)
  ─▶ public/js/world.js        (mega park view)  /  public/js/scene.js (scenes view)
```

- `src/mapping/table.ts` is data only: event/tool → dog and trainer state.
  Change behaviour there first; `store.ts` applies it.
- Hosts: Codex and Copilot CLI send Claude-shaped payloads; the only
  differences are tool names (`TOOL_ALIASES` in `table.ts`, applied in
  `sanitize.ts`) and a few events (`Interrupt`, `ErrorOccurred`). The forwarder
  passes `--source` as the `X-Zoomies-Source` header. Installer targets per
  host live in `src/install.ts` and `src/hooks-config.ts`.
- `public/js/model.js` holds all UI decisions without the DOM (who goes to the
  bar, where actors walk, what each state does on the terrain, throw and
  fetch…). `world.js` and `scene.js` only draw. Keep new logic in `model.js`
  and test it in `test/ui-model.test.ts`.
- Art lives in `art/` as text sources; `public/art/` is generated.

## Commands

```sh
npm install              # installs and builds dist/
npm test                 # tsc + every vitest suite (server, mapper, UI, art, installer)
npm run typecheck
npm run art:build        # art/ → public/art/ (commit the result)
npm run art:check        # palette, grid, outline, public/art/ up to date
npm run serve            # http://127.0.0.1:3737 in the foreground (= node bin/zoomies.mjs serve)
npm start / npm stop     # the same in the background (pid and log in run/; npm run status)
npm run demo             # replays examples/demo.jsonl against it
npm run screenshots      # regenerate README images (see CONTRIBUTING.md)
```

The CLI runs from `dist/`: after changing `src/`, run `npm run build` before
using `bin/zoomies.mjs`. A running server must be restarted to pick up
server changes (`npm restart` for one started with `npm start`); frontend
changes only need a page reload.

## Rules that must not break

- **Privacy**: raw hook payloads (prompts, file contents, commands,
  `tool_response`, transcripts) never leave `sanitize.ts`. Nothing reaches the
  state, the WebSocket or the disk except the fields of `NormalizedEvent`, and
  bubble text is capped at 40 characters. Record mode is the only exception
  and is opt-in. `test/server-ws.test.ts` checks secrets never reach the wire.
- **The forwarder is invisible**: `bin/zoomies-hook.cjs` must never write to
  stdout/stderr (hosts read stdout as control JSON that can approve tools),
  must always exit 0 and must stay dependency-free and fast (~30 ms).
  Copilot CLI denies a tool when a `preToolUse` hook fails, so its installed
  commands also swallow failures (`|| true` / `; exit 0`): keep that.
- **Local only**: the server binds to 127.0.0.1 and checks the remote IP,
  `Host` and `Origin` (see `src/security.ts`). Do not relax these checks.
- **Installer safety**: `src/install.ts` merges, backs up, writes atomically
  and only removes its own handlers. Keep it that way.
- **Art**: never hand-edit `public/art/`; edit `art/` and run `art:build`.
  16-colour palette, integer scaling, 1 px `ink` outline, light from the top
  left (`STYLE.md`). Every breed must have exactly the same animations; the
  trainer's animations must be exactly `TRAINER_STATES` + `TRAINER_UI_ANIMS`
  (tests enforce both).
- **Everything in English**: code, comments, UI text, docs.

## Conventions

- Match the surrounding code: small pure functions, short doc comments that
  explain *why*, no framework in the frontend, no new runtime dependencies
  without a strong reason (the server only depends on `ws`).
- Names in `table.ts`, sprite animations and map files must stay in sync (a
  state name is also an animation name in the atlas).
- Add or update tests with every behaviour change. UI movement is tested by
  stepping actors in `test/ui-model.test.ts` with a fixed random function.
- A new visible feature gets its own README screenshot, and a visual change
  to something already shown regenerates the images it affects, both in the
  same branch, before the pull request (skill `readme-screenshots`).

## Verifying a change

1. `npm test` (and `npm run art:check` if you touched art).
2. For UI changes, run the server, replay `examples/demo.jsonl` and look at
   the page. Without a browser, `npm run screenshots -- --burst` captures
   frames with headless Chrome into `tmp/screenshots/`.
3. For art, `node bin/zoomies.mjs art preview <sprite> tmp/x.png --scale 8`.

## Project skills

`.claude/skills/` has step-by-step loops for dog and trainer sprites
(`dog-sprite`), tiles and maps (`park-tile`), props (`prop-sprite`) and the
README screenshots (`readme-screenshots`).
