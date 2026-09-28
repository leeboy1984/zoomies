// Dog Park: live view of your Claude Code sessions.
import { BUCKET_LABEL, arrangeScenes, companionSprite, displayDogState } from "./model.js";
import { connect } from "./net.js";
import { Scene } from "./scene.js";
import { World } from "./world.js";
import { createSpriteProvider, loadMap } from "./sprites.js";

const params = new URLSearchParams(location.search);
const MAX_VISIBLE = Math.min(9, Math.max(1, Number(params.get("max")) || 4));

const sessions = new Map();
const pinned = new Set();
const views = new Map(); // id → { el, scene, header }
let kennelKey = "";

const $scenes = document.getElementById("scenes");
const $kennel = document.getElementById("kennel");
const $kennelList = document.getElementById("kennel-list");
const $status = document.getElementById("status");
const $empty = document.getElementById("empty");
const $worldView = document.getElementById("world-view");
const $worldCanvas = document.getElementById("world");
const $alerts = document.getElementById("alerts");
let world = null;
let alertsKey = "";

// View: mega park (default) or scenes. ?view=scenes wins; otherwise the last one picked.
function storedView() {
  try {
    return localStorage.getItem("zoomies.view");
  } catch {
    return null;
  }
}
let view = params.get("view") === "scenes" || (params.get("view") !== "world" && storedView() === "scenes") ? "scenes" : "world";
function setView(next) {
  view = next;
  try {
    localStorage.setItem("zoomies.view", next);
  } catch {
    // no storage: it only lasts this visit
  }
  for (const b of document.querySelectorAll(".views button")) b.setAttribute("aria-pressed", String(b.dataset.view === view));
  $worldView.hidden = view !== "world";
  $scenes.hidden = view !== "scenes";
  layout();
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function makeView(session, sprites, maps) {
  const el = document.createElement("article");
  el.className = "scene";
  el.innerHTML = `
    <header>
      <span class="project"></span>
      <span class="badge"></span>
      <span class="obstacles" title="Tasks completed"></span>
      <span class="ago"></span>
      <button class="unpin" title="Send back to the kennel" hidden>×</button>
    </header>
    <canvas></canvas>`;
  const scene = new Scene(el.querySelector("canvas"), sprites, maps);
  el.querySelector(".unpin").addEventListener("click", () => {
    pinned.delete(session.id);
    layout();
  });
  return { el, scene };
}

function renderHeader(view, s, now) {
  const q = (sel) => view.el.querySelector(sel);
  q(".project").textContent = s.platform && s.platform !== "claude" ? `${s.project} · ${s.platform}` : s.project;
  q(".badge").textContent = BUCKET_LABEL[s.bucket];
  q(".obstacles").textContent = s.obstacles ? `🏅 ${s.obstacles}` : "";
  q(".ago").textContent = ago(now - s.lastEventAt);
  q(".unpin").hidden = !pinned.has(s.id);
  view.el.dataset.bucket = s.bucket;
}

let sprites;
let maps;

function layout() {
  const now = Date.now();
  if (world) world.setSessions([...sessions.values()], { pinned, now });
  if (view === "world") {
    $kennel.hidden = true;
    $empty.hidden = sessions.size > 0;
    const needs = world ? world.needsYou() : [];
    const key = needs.map((n) => n.id).join("|");
    if (key !== alertsKey) {
      alertsKey = key;
      $alerts.replaceChildren(
        ...needs.map((n) => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = `⚠ ${n.project}`;
          b.title = "Go to this session";
          b.addEventListener("click", () => world.focus(n.id));
          return b;
        }),
      );
    }
    updateTitle();
    return;
  }
  const { visible, kennel } = arrangeScenes([...sessions.values()], { max: MAX_VISIBLE, pinned, now });
  const ids = new Set(visible.map((s) => s.id));
  for (const [id, v] of views) {
    if (!ids.has(id)) {
      v.el.remove();
      views.delete(id);
    }
  }
  visible.forEach((s, i) => {
    let v = views.get(s.id);
    if (!v) {
      v = makeView(s, sprites, maps);
      views.set(s.id, v);
    }
    v.scene.update(s);
    if ($scenes.children[i] !== v.el) $scenes.insertBefore(v.el, $scenes.children[i] ?? null);
  });
  $scenes.dataset.count = String(visible.length);
  $empty.hidden = sessions.size > 0;

  // Kennel: only rebuilt when its content changes.
  const key = kennel.map((s) => `${s.id}:${s.bucket}:${s.project}`).join("|");
  $kennel.hidden = kennel.length === 0;
  if (key !== kennelKey) {
    kennelKey = key;
    $kennelList.replaceChildren(
      ...kennel.map((s) => {
        const b = document.createElement("button");
        b.className = "kennel-card";
        b.dataset.bucket = s.bucket;
        b.title = "Take out of the kennel";
        b.innerHTML = `<canvas width="48" height="48"></canvas><span class="project"></span><span class="badge"></span>`;
        b.querySelector(".project").textContent = s.project;
        b.querySelector(".badge").textContent = BUCKET_LABEL[s.bucket];
        b.dataset.id = s.id;
        b.addEventListener("click", () => {
          pinned.add(s.id);
          while (pinned.size > MAX_VISIBLE) pinned.delete(pinned.values().next().value);
          layout();
        });
        return b;
      }),
    );
  }

  updateTitle();
}

function updateTitle() {
  const needs = [...sessions.values()].filter((s) => s.bucket === "needs_you").length;
  document.title = needs ? `(${needs}) You're needed! · Dog Park` : "Dog Park";
}

function resize() {
  for (const v of views.values()) {
    const map = v.scene.map;
    const native = map.width * map.tileSize;
    const width = v.el.clientWidth - 4;
    // Integer scale if it fits at ×2 or more; otherwise it is drawn at ×2 and
    // the browser shrinks it to the available width (still crisp, but not an exact multiple).
    const fit = Math.floor(width / native);
    v.scene.setScale(Math.max(2, fit));
    v.scene.canvas.classList.toggle("shrink", fit < 2);
  }
}

let last = performance.now();
function frame(t) {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  const now = Date.now();
  if (view === "world" && world) {
    const top = $worldCanvas.getBoundingClientRect().top;
    const width = $worldCanvas.parentElement.clientWidth;
    world.resize(width, Math.max(320, Math.floor(window.innerHeight - top - 40)));
    world.draw(now, dt);
    requestAnimationFrame(frame);
    return;
  }
  resize();
  for (const [id, v] of views) {
    const s = sessions.get(id);
    if (!s) continue;
    renderHeader(v, s, now);
    v.scene.draw(now, dt);
  }
  for (const card of $kennelList.children) {
    const s = sessions.get(card.dataset.id);
    const c = card.querySelector("canvas");
    if (!s || !c) continue;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    const state = displayDogState(s.companion, now, s.bucket === "ended", s.bucket === "working");
    sprites.draw(ctx, companionSprite(s.companionLook), state === "leaves" ? "sleeps" : state, now, 24, 40, { scale: 2 });
  }
  requestAnimationFrame(frame);
}

async function main() {
  sprites = await createSpriteProvider("/art");
  const names = ["park", "forest", "agility", "beach", "square", "snow"];
  maps = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await loadMap(n, "/art")])));
  world = new World($worldCanvas, sprites, maps, {
    onPin: (id) => {
      pinned.add(id);
      layout();
    },
  });
  document.getElementById("zoom-in").addEventListener("click", () => world.zoomAt(1, $worldCanvas.width / 2, $worldCanvas.height / 2));
  document.getElementById("zoom-out").addEventListener("click", () => world.zoomAt(-1, $worldCanvas.width / 2, $worldCanvas.height / 2));
  document.getElementById("zoom-fit").addEventListener("click", () => world.fit());
  for (const b of document.querySelectorAll(".views button")) b.addEventListener("click", () => setView(b.dataset.view));
  setView(view);

  connect({
    onSnapshot: (list) => {
      sessions.clear();
      for (const s of list) sessions.set(s.id, s);
      layout();
    },
    onSession: (s) => {
      sessions.set(s.id, s);
      layout();
    },
    onRemove: (id) => {
      sessions.delete(id);
      pinned.delete(id);
      layout();
    },
    onStatus: (text) => {
      $status.textContent = text;
      $status.dataset.state = text;
    },
  });
  setInterval(layout, 5_000); // move sessions that go idle to the bar
  window.addEventListener("resize", resize);
  requestAnimationFrame(frame);
}

main().catch((err) => {
  $status.textContent = `error: ${err.message}`;
});
