#!/usr/bin/env node
// Regenerates the README screenshots (docs/img/) with headless Chrome.
//
//   npm run screenshots -- --burst    capture bursts of full screenshots into tmp/screenshots/burst-<run>/
//   npm run screenshots -- --compose  compose docs/img/*.png from those bursts, using the times in shots.json
//   npm run screenshots               both, one after the other
//   … --burst --only fullscreen,bar   capture only those runs (the other bursts are kept)
//
// Two runs never look exactly the same (movement follows the browser's real
// frame timing), so the workflow is: capture a burst, look at the frames,
// write the times you like into shots.json, and compose from that same burst.
//
// It starts its own zoomies server (port 3739) and Chrome instance (DevTools
// port 9339, throwaway profile in tmp/), replays scripts/screenshots/scenario.mjs
// and drives the page through the Chrome DevTools Protocol. It never touches
// your browser or your running zoomies server. Chrome is looked up in the usual
// places; set CHROME_PATH to use another one. Run `npm run build` first.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createImage, decodePng, encodePng, getPixel, setPixel } from "../../dist/art/png.js";
import { buildScenario } from "./scenario.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TMP = join(ROOT, "tmp", "screenshots");
const PORT = 3739;
const DEVTOOLS = 9339;
const VIEWPORT = { width: 3700, height: 1620 }; // the whole world at ×3, with labels and bubbles
const BG = [0x1f, 0x1a, 0x24, 255]; // page background, between tiles of a composed image
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error("Chrome not found: install Google Chrome or Chromium, or set CHROME_PATH");
  return found;
}

/**
 * One run: fresh server, fresh Chrome, replay the scenario and take a full-page
 * screenshot at each requested second. `clockShiftMin` moves the page clock
 * forward (the bar only fills up after sessions have been idle for 5 minutes);
 * `viewport` and `query` pick the screen size and the page URL (e.g. full screen).
 */
async function captureRun({ times, clockShiftMin = 0, outDir, viewport = VIEWPORT, query = "?view=world" }) {
  mkdirSync(outDir, { recursive: true });
  const scenario = join(TMP, "scenario.jsonl");
  writeFileSync(scenario, buildScenario());
  const server = spawn(process.execPath, ["bin/zoomies.mjs", "serve", "--port", String(PORT)], { cwd: ROOT, stdio: "ignore" });
  const chrome = spawn(chromePath(), [
    "--headless=new", `--remote-debugging-port=${DEVTOOLS}`, `--user-data-dir=${join(TMP, "chrome-profile")}`,
    "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", `--window-size=${viewport.width},${viewport.height}`, "about:blank",
  ], { stdio: "ignore" });
  const stop = () => {
    chrome.kill();
    server.kill();
  };
  try {
    let targets;
    for (let i = 0; i < 100 && !targets; i++) {
      await sleep(100);
      try {
        targets = await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`)).json();
      } catch {}
    }
    if (!targets) throw new Error("Chrome did not start its DevTools endpoint");
    const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => ws.once("open", r));
    let seq = 0;
    const pending = new Map();
    ws.on("message", (m) => {
      const d = JSON.parse(m);
      if (d.id && pending.has(d.id)) {
        pending.get(d.id)(d);
        pending.delete(d.id);
      }
    });
    const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });

    await cdp("Page.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
    // Seeded randomness, so two runs look (nearly) the same; optional clock shift.
    await cdp("Page.addScriptToEvaluateOnNewDocument", {
      source: `{let s=42;Math.random=()=>{s|=0;s=s+0x6D2B79F5|0;let t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296};` +
        (clockShiftMin ? `const o=Date.now.bind(Date);Date.now=()=>o()+${clockShiftMin}*60000;` : "") + "}",
    });
    await cdp("Page.navigate", { url: `http://127.0.0.1:${PORT}/${query}` });
    await sleep(1500);
    const replay = spawn(process.execPath, ["bin/zoomies.mjs", "replay", scenario, "--port", String(PORT), "--keep-ids"], { cwd: ROOT, stdio: "ignore" });
    const t0 = Date.now();
    const files = {};
    for (const t of [...times].sort((a, b) => a - b)) {
      const wait = t0 + t * 1000 - Date.now();
      if (wait > 0) await sleep(wait);
      const { result } = await cdp("Page.captureScreenshot", { format: "png" });
      files[t] = join(outDir, `t${t.toFixed(1).padStart(5, "0")}.png`);
      writeFileSync(files[t], Buffer.from(result.data, "base64"));
    }
    replay.kill();
    return files;
  } finally {
    stop();
  }
}

/** Crops regions ([x, y, w, h] of a frame) and lays them out in a grid. */
function compose(out, { cols = 1, gap = 0, tiles }, frames) {
  const [, , W, H] = tiles[0].crop;
  const rows = Math.ceil(tiles.length / cols);
  const img = createImage(cols * W + (cols + 1) * gap, rows * H + (rows + 1) * gap);
  for (let i = 0; i < img.width * img.height; i++) img.data.set(BG, i * 4);
  const cache = new Map();
  tiles.forEach((tile, i) => {
    const file = frames[tile.run][tile.t];
    if (!cache.has(file)) cache.set(file, decodePng(readFileSync(file)));
    const src = cache.get(file);
    const [x0, y0, w, h] = tile.crop;
    const ox = gap + (i % cols) * (W + gap);
    const oy = gap + Math.floor(i / cols) * (H + gap);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, ox + x, oy + y, getPixel(src, x0 + x, y0 + y));
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, encodePng(img));
  console.log(`${out}  ${img.width}x${img.height}`);
}

/** Frames of a burst, by time (from their file names). */
function burstFrames(name) {
  const dir = join(TMP, `burst-${name}`);
  if (!existsSync(dir)) throw new Error(`no burst for "${name}": run npm run screenshots -- --burst first`);
  const frames = {};
  for (const f of readdirSync(dir)) {
    const m = f.match(/^t(\d+\.\d)\.png$/);
    if (m) frames[Number(m[1])] = join(dir, f);
  }
  // shots.json may ask for a time between two frames: use the closest one.
  return new Proxy(frames, {
    get: (all, t) => all[Object.keys(all).map(Number).reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a))],
  });
}

const config = JSON.parse(readFileSync(new URL("./shots.json", import.meta.url), "utf8"));
const both = !process.argv.includes("--burst") && !process.argv.includes("--compose");
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg === -1 ? null : new Set(process.argv[onlyArg + 1].split(","));
if (only) for (const name of only) if (!config.runs[name]) throw new Error(`unknown run "${name}" (shots.json has: ${Object.keys(config.runs).join(", ")})`);
if (both || process.argv.includes("--burst")) {
  for (const [name, run] of Object.entries(config.runs)) {
    if (only && !only.has(name)) continue;
    const times = [];
    for (let t = run.burst[0]; t <= run.burst[1] + 1e-9; t += run.burst[2]) times.push(Math.round(t * 10) / 10);
    rmSync(join(TMP, `burst-${name}`), { recursive: true, force: true });
    await captureRun({ times, clockShiftMin: run.clockShiftMin, viewport: run.viewport, query: run.query, outDir: join(TMP, `burst-${name}`) });
    console.log(`tmp/screenshots/burst-${name}/  ${times.length} frames`);
  }
}
if (both || process.argv.includes("--compose")) {
  const frames = Object.fromEntries(Object.keys(config.runs).map((name) => [name, burstFrames(name)]));
  for (const [file, img] of Object.entries(config.images)) compose(join(ROOT, "docs", "img", file), img, frames);
}
process.exit(0);
