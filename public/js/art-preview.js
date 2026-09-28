// Art test page: the park with dogs placed around it and a catalogue of every
// variant and animation.
import { createSpriteProvider, drawMap, loadMap } from "./sprites.js";

const INK = "#1f1a24";
const CREAM = "#f2dfb4";
const WHITE = "#fbf7ef";
// Breed → coats (same as BREED_COATS in src/mapping/table.ts).
const BREEDS = {
  dachshund: ["red", "black_tan", "chocolate"],
  beagle: ["tricolor", "lemon"],
  border_collie: ["black", "red", "merle"],
  pug: ["fawn", "black"],
  mutt: ["cinnamon", "golden", "grey", "cream"],
};
const STATES = ["idle", "runs", "asks"];
const TRAINER_STATES = ["enters", "idle", "notebook", "stopwatch", "whistles", "points", "celebrates", "leaves"];

function bubble(ctx, text, x, y, scale) {
  ctx.font = `bold ${6 * scale}px ui-monospace, monospace`;
  const w = Math.ceil(ctx.measureText(text).width) + 6 * scale;
  const h = 10 * scale;
  const bx = Math.round(x - w / 2);
  const by = Math.round(y - h - 4 * scale);
  ctx.fillStyle = INK;
  ctx.fillRect(bx - scale, by - scale, w + 2 * scale, h + 2 * scale);
  ctx.fillRect(x - 2 * scale, by + h, 4 * scale, 3 * scale);
  ctx.fillStyle = WHITE;
  ctx.fillRect(bx, by, w, h);
  ctx.fillRect(x - scale, by + h, 2 * scale, 2 * scale);
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  ctx.fillText(text, bx + 3 * scale, by + h / 2 + scale / 2);
}

function label(ctx, text, x, y) {
  ctx.font = "14px ui-monospace, monospace";
  ctx.fillStyle = CREAM;
  ctx.textBaseline = "top";
  ctx.fillText(text, x, y);
}

async function main() {
  const sprites = await createSpriteProvider("/art");
  const MAPS = ["park", "forest", "agility", "beach", "square", "snow"];
  const wanted = new URLSearchParams(location.search).get("map");
  const mapName = MAPS.includes(wanted) ? wanted : "park";
  const map = await loadMap(mapName, "/art");

  const S = 3; // park scale
  const T = map.tileSize * S;
  const park = document.getElementById("park");
  park.width = map.width * T;
  park.height = map.height * T;
  const pctx = park.getContext("2d");

  // Static background, pre-rendered once.
  const bg = document.createElement("canvas");
  bg.width = park.width;
  bg.height = park.height;
  const bctx = bg.getContext("2d");
  bctx.imageSmoothingEnabled = false;
  drawMap(bctx, sprites, map, S);

  const at = ([tx, ty]) => [(tx + 0.5) * T, (ty + 1) * T]; // feet at the bottom centre of the tile

  const catalogue = document.getElementById("catalogue");
  const C = 4;
  const cell = 16 * C + 24;
  catalogue.width = park.width;
  const trainerRow = 32 * C + 40;
  catalogue.height = 40 + (Object.keys(BREEDS).length + 1) * cell + trainerRow;
  const cctx = catalogue.getContext("2d");

  function frame(t) {
    // Park
    pctx.imageSmoothingEnabled = false;
    pctx.drawImage(bg, 0, 0);
    const actors = [];
    const [bx, by] = at(map.spots.bed);
    actors.push({ y: by, draw: () => sprites.draw(pctx, "prop.bed", "default", t, bx, by, { scale: S }) });
    for (const [name, spot] of Object.entries(map.spots.props)) {
      const [x, y] = at(spot);
      actors.push({ y, draw: () => sprites.draw(pctx, `prop.${name}`, "default", t, x, y, { scale: S }) });
    }
    // In agility the companion hops from obstacle to obstacle (one every 1.5 s).
    const course = map.spots.obstacles ?? [];
    const step = course.length ? Math.floor(t / 1500) % (course.length + 1) : 0;
    const [cx, cy] = at(step > 0 ? course[step - 1] : map.spots.companion);
    actors.push({
      y: cy,
      draw: () => {
        sprites.draw(pctx, "dog.dachshund.red", course.length && step > 0 ? "agility" : "idle", t, cx, cy, { scale: S });
        bubble(pctx, course.length ? `obstacle ${step}/${course.length}` : "login.ts", cx, cy - 16 * S, S / 1.5);
      },
    });
    // A border collie runs from one side of the path to the other.
    const span = (map.width - 4) * T;
    const phase = (t / 6000) % 2;
    const goingRight = phase < 1;
    const runX = 2 * T + (goingRight ? phase : 2 - phase) * span;
    const runY = 10 * T;
    actors.push({ y: runY, draw: () => sprites.draw(pctx, "dog.border_collie.black", "runs", t, runX, runY, { scale: S, flip: !goingRight }) });
    const puppies = map.spots.puppies.map(at);
    const [p0x, p0y] = puppies[0];
    actors.push({
      y: p0y,
      draw: () => {
        sprites.draw(pctx, "dog.beagle.tricolor", "asks", t, p0x, p0y, { scale: S });
        bubble(pctx, "?", p0x, p0y - 16 * S, S / 1.5);
      },
    });
    const [p1x, p1y] = puppies[1];
    actors.push({ y: p1y, draw: () => sprites.draw(pctx, "dog.pug.fawn", "idle", t + 300, p1x, p1y, { scale: S, flip: true }) });
    const [p2x, p2y] = puppies[2];
    actors.push({ y: p2y, draw: () => sprites.draw(pctx, "dog.dachshund.black_tan", "idle", t + 700, p2x, p2y, { scale: S }) });
    // The trainer cycles through their states every 2.5 s.
    const [tx, ty] = at(map.spots.trainer);
    const tstate = TRAINER_STATES[1 + (Math.floor(t / 2500) % (TRAINER_STATES.length - 2))];
    actors.push({
      y: ty,
      draw: () => {
        sprites.draw(pctx, "trainer.cap.medium", tstate, t, tx, ty, { scale: S });
        bubble(pctx, tstate, tx, ty - 32 * S, S / 1.5);
      },
    });
    actors.sort((a, b) => a.y - b.y).forEach((a) => a.draw());

    // Catalogue
    cctx.imageSmoothingEnabled = false;
    cctx.fillStyle = "#2a2331";
    cctx.fillRect(0, 0, catalogue.width, catalogue.height);
    const cols = [...STATES, "runs (mirrored)"];
    const colX = (i) => 170 + i * (cell + 30);
    cols.forEach((s, i) => label(cctx, s, colX(i), 12));
    label(cctx, "coats", colX(cols.length) + 40, 12);
    Object.entries(BREEDS).forEach(([breed, coats], r) => {
      const y = 40 + r * cell;
      label(cctx, breed, 12, y + cell / 2 - 10);
      cols.forEach((s, i) => {
        const x = colX(i) + cell / 2;
        const anim = s.startsWith("runs") ? "runs" : s;
        sprites.draw(cctx, `dog.${breed}.${coats[0]}`, anim, t, x, y + 16 * C + 4, { scale: C, flip: s.includes("mirrored") });
      });
      coats.forEach((coat, i) => {
        sprites.draw(cctx, `dog.${breed}.${coat}`, "idle", t + i * 200, colX(cols.length) + 70 + i * 60, y + 16 * C + 4, { scale: 3 });
      });
    });
    const py = 40 + Object.keys(BREEDS).length * cell;
    label(cctx, "props", 12, py + cell / 2 - 10);
    ["ball", "bone", "bed"].forEach((p, i) => {
      sprites.draw(cctx, `prop.${p}`, "default", t, 170 + i * (cell + 60) + cell / 2, py + 16 * C + 4, { scale: C });
    });

    const ty2 = 40 + (Object.keys(BREEDS).length + 1) * cell;
    label(cctx, "trainer", 12, ty2 + 16 * C - 10);
    TRAINER_STATES.forEach((s, i) => {
      const x = 170 + i * 120 + 32;
      const styles = ["cap", "beanie", "long_hair", "hat", "ponytail"];
      const skins = ["light", "medium", "brown", "dark"];
      sprites.draw(cctx, `trainer.${styles[i % 5]}.${skins[i % 4]}`, s, t, x, ty2 + 32 * C, { scale: C });
      label(cctx, s, x - 36, ty2 + 32 * C + 8);
    });

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((err) => {
  document.body.insertAdjacentHTML("beforeend", `<p>Error: ${String(err.message).replace(/</g, "&lt;")}</p>`);
});
