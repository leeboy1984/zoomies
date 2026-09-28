// Draws one session on its own canvas: scene, trainer, companion, puppies,
// props, shadows and bubbles. Movement (arriving, leaving, puppies running off
// and back) is simple interpolation on the client.
import { drawMap } from "./sprites.js";
import {
  SEARCH_MOTION,
  TRAINER_MOTION,
  agilityCourse,
  agilitySpot,
  assignPuppySpots,
  beginRetrieve,
  companionSprite,
  displayDogState,
  displayTrainerState,
  dogAnim,
  dogBubble,
  dogMotion,
  groundAt,
  jumpLift,
  fetchSpot,
  lastToy,
  toyAirborne,
  mapWalkable,
  markSpots,
  mouthOffset,
  newActor,
  puppySprite,
  HAND_WINDUP,
  setActorGoal,
  stepActor,
  throwPose,
  toyPosition,
  trainerAnim,
  trainerBubble,
  trainerFlip,
  trainerSprite,
} from "./model.js";

const INK = "#1f1a24";
const WHITE = "#fbf7ef";
const GOLD = "#f0c04a";
const DOG_SPEED = 80; // native px per second
const TRAINER_SPEED = 40;

export function drawBubble(ctx, text, x, y, s, { alert = false } = {}) {
  ctx.font = `bold ${Math.max(11, Math.round(6 * s))}px ui-monospace, monospace`;
  const pad = 2 * s;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = Math.max(15, Math.round(9 * s));
  const bx = Math.round(Math.min(Math.max(x - w / 2, s), ctx.canvas.width - w - s));
  const by = Math.round(y - h - 3 * s);
  ctx.fillStyle = INK;
  ctx.fillRect(bx - s, by - s, w + 2 * s, h + 2 * s);
  ctx.fillRect(Math.round(x - 1.5 * s), by + h, 3 * s, 2 * s);
  ctx.fillStyle = alert ? GOLD : WHITE;
  ctx.fillRect(bx, by, w, h);
  ctx.fillRect(Math.round(x - 0.5 * s), by + h, s, s);
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  ctx.fillText(text, bx + pad, by + h / 2 + s / 4);
}

export function shadow(ctx, x, y, s) {
  ctx.fillStyle = "rgba(31, 26, 36, 0.3)";
  ctx.beginPath();
  ctx.ellipse(x, y - s / 2, 5 * s, 1.5 * s, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** Pee stream (in screen px): three drops falling from the raised leg towards the object. */
export function drawPee(ctx, x, y, S, face, now) {
  ctx.fillStyle = GOLD;
  const sx = Math.round(x - face * 8 * S);
  for (let i = 0; i < 3; i++) {
    const t = ((now / 260 + i / 3) % 1);
    ctx.fillRect(sx - face * Math.round(t * 2) * S, Math.round(y - (5 - t * 5) * S), S, S);
  }
  ctx.fillRect(face > 0 ? sx - 2 * S : sx + S, y - S, 2 * S, S); // little puddle
}

export class Scene {
  constructor(canvas, sprites, maps) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.sprites = sprites;
    this.maps = maps;
    this.session = null;
    this.scale = 2;
    /** id → { x, y, tx, ty } in native map px (feet). */
    this.pos = new Map();
    this.puppySpots = new Map();
    this.bg = null;
  }

  get map() {
    return this.maps[this.session?.scenario] ?? this.maps.park;
  }

  setScale(scale) {
    if (scale === this.scale && this.bg) return;
    this.scale = scale;
    this.bg = null;
  }

  update(session) {
    const first = !this.session;
    const scenarioChanged = this.session && this.session.scenario !== session.scenario;
    this.session = session;
    if (scenarioChanged) this.bg = null;
    const map = this.map;
    const T = map.tileSize;
    const spot = ([tx, ty]) => [(tx + 0.5) * T, (ty + 1) * T];
    const offLeft = -T;
    const offRight = map.width * T + T;

    // Trainer
    const [trX, trY] = spot(map.spots.trainer);
    const tr = displayTrainerState(session.trainer, Date.now());
    this.place("trainer", tr === "enters" && first ? [offLeft, trY] : null, tr === "leaves" ? [offLeft, trY] : [trX, trY], TRAINER_MOTION[tr]);

    // Companion
    const home = spot(session.scenario === "agility" ? agilitySpot(map, session.obstacles) : map.spots.companion);
    const now = Date.now();
    const ended = session.bucket === "ended";
    const working = session.bucket === "working";
    const cs = displayDogState(session.companion, now, ended, working);
    const terrain = this.terrain;
    // Fetching: the trainer throws something from their spot.
    const fetching = cs === "fetches";
    this.place(
      "companion",
      cs === "arrives" && first ? [offLeft, home[1]] : null,
      cs === "leaves" ? [offRight, home[1]] : fetching ? fetchSpot([trX, trY], (map.width * T) / 2, T) : home,
      fetching ? SEARCH_MOTION : dogMotion(cs, terrain),
    );
    // One toy per search running in parallel.
    this.pos.get("companion").wantToys = session.fetching ?? 1;

    // Puppies: run from the trainer to their slot and back.
    this.puppySpots = assignPuppySpots(session.puppies, map.spots.puppies.length, this.puppySpots);
    const alive = new Set(["trainer", "companion"]);
    for (const p of session.puppies) {
      const key = `p:${p.id}`;
      alive.add(key);
      const idx = this.puppySpots.get(p.id);
      const target = p.state === "returns" || idx === undefined ? [trX, trY] : spot(map.spots.puppies[idx]);
      this.place(key, [trX, trY], target, dogMotion(displayDogState(p, now, ended, working), terrain));
    }
    for (const key of [...this.pos.keys()]) if (!alive.has(key)) this.pos.delete(key);
  }

  /** Creates the actor at `start` (or at `target` if there is no start) and gives it a spot and a way of moving. */
  place(key, start, target, motion = null) {
    let cur = this.pos.get(key);
    if (!cur) {
      cur = newActor(start ?? target);
      this.pos.set(key, cur);
    }
    // In the middle of a lap, going to mark or bringing back a toy: new goals wait until it finishes.
    if (cur.commit || beginRetrieve(cur, motion ?? null)) {
      cur.pending = [start, target, motion];
      return;
    }
    setActorGoal(cur, target, motion ?? null);
  }

  /** What the current map's terrain offers: where to mark and the agility course. */
  get terrain() {
    const map = this.map;
    this.terrainCache ??= new Map();
    if (!this.terrainCache.has(map)) this.terrainCache.set(map, { marks: markSpots(map, [0, 0], map.tileSize), course: agilityCourse(map, [0, 0], map.tileSize) });
    return this.terrainCache.get(map);
  }

  step(dt) {
    const map = this.map;
    const T = map.tileSize;
    const env = {
      tile: T,
      walkable: (x, y) => mapWalkable(map, x, y),
      ground: (x, y) => groundAt(map, x, y),
      bounds: { x0: T, x1: (map.width - 1) * T, y0: 3 * T, y1: map.height * T },
      centerX: (map.width * T) / 2,
      ...this.terrain,
    };
    // The trainer does not stroll along the edges (they would end up staring at them).
    const trainerBounds = { ...env.bounds, x0: 3 * T, x1: (map.width - 3) * T };
    for (const [key, p] of this.pos) {
      const thrower = key === "companion" ? this.pos.get("trainer") : undefined;
      const bounds = key === "trainer" ? trainerBounds : env.bounds;
      stepActor(p, dt, key === "trainer" ? TRAINER_SPEED : DOG_SPEED, { ...env, bounds, thrower });
      if (!p.commit && p.pending) {
        const args = p.pending;
        p.pending = null;
        this.place(key, ...args);
      }
    }
  }

  ensureBackground() {
    if (this.bg) return;
    const map = this.map;
    const s = this.scale;
    this.canvas.width = map.width * map.tileSize * s;
    this.canvas.height = map.height * map.tileSize * s;
    const bg = document.createElement("canvas");
    bg.width = this.canvas.width;
    bg.height = this.canvas.height;
    const bctx = bg.getContext("2d");
    bctx.imageSmoothingEnabled = false;
    drawMap(bctx, this.sprites, map, s);
    this.bg = bg;
  }

  draw(now, dt) {
    if (!this.session) return;
    this.ensureBackground();
    this.step(dt);
    const { ctx, scale: s, session } = this;
    const map = this.map;
    const T = map.tileSize;
    const ended = session.bucket === "ended";
    const working = session.bucket === "working";
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.bg, 0, 0);

    const items = [];
    const trainer = this.pos.get("trainer");
    const at = ([tx, ty]) => [(tx + 0.5) * T * s, (ty + 1) * T * s];

    // Fixed scene props
    if (map.spots.bed) {
      const [x, y] = at(map.spots.bed);
      items.push({ y, draw: () => this.sprites.draw(ctx, "prop.bed", "default", now, x, y, { scale: s }) });
    }
    for (const [name, spot] of Object.entries(map.spots.props ?? {})) {
      const [x, y] = at(spot);
      items.push({ y, draw: () => this.sprites.draw(ctx, `prop.${name}`, "default", now, x, y, { scale: s }) });
    }

    // Trainer
    if (trainer) {
      const x = trainer.x * s;
      const y = trainer.y * s;
      const dog = this.pos.get("companion");
      const thrown = lastToy(dog);
      const pose = throwPose(thrown);
      const anim = pose ?? trainerAnim(displayTrainerState(session.trainer, now), trainer.moving);
      const flip = trainerFlip(trainer, dog, thrown);
      const text = trainerBubble(session.trainer);
      items.push({
        y,
        draw: () => {
          shadow(ctx, x, y, s);
          this.sprites.draw(ctx, trainerSprite(session.trainerLook), anim, now, x, y, { scale: s, flip });
          if (pose === "winds_up") {
            const [hx, hy] = HAND_WINDUP;
            this.sprites.draw(ctx, `toy.${thrown.kind}`, "default", now, x + (flip ? -hx : hx) * s, y + hy * s, { scale: s, flip });
          }
        },
        bubble: text && (() => drawBubble(ctx, text, x, y - 32 * s + Math.sin(now / 150) * s, s, { alert: text === "!" })),
      });
    }

    // Dogs
    const dog = (key, sprite, actor, faceX) => {
      const p = this.pos.get(key);
      if (!p) return;
      const shown = displayDogState(actor, now, ended, working);
      if (p.act === "tunnel") return; // inside the tunnel
      const anim = dogAnim(shown, p.moving, p.fast, p.act);
      const lift = Math.round(jumpLift(p)) * s;
      const flip = p.moving || p.motion ? p.dir < 0 : faceX !== null && faceX < p.x;
      const x = p.x * s;
      const y = p.y * s;
      // No bubble while a toy is being thrown: it would cover the trainer's wind-up.
      const text = (p.moving && !p.motion) || toyAirborne(p) ? null : dogBubble(actor, shown, now);
      items.push({
        y,
        draw: () => {
          shadow(ctx, x, y, s);
          this.sprites.draw(ctx, sprite, anim, now, x, y - lift, { scale: s, flip });
          if (anim === "pees") drawPee(ctx, x, y, s, flip ? -1 : 1, now);
          // What the trainer threw, in its mouth.
          const held = p.toys?.find((toy) => toy.carried);
          if (held) {
            const [mx, my] = mouthOffset(sprite, anim);
            this.sprites.draw(ctx, `toy.${held.kind}`, "default", now, x + (flip ? -mx : mx) * s, y - lift + my * s, { scale: s, flip });
          }
        },
        bubble: text && (() => drawBubble(ctx, text, x, y - lift - 16 * s, s, { alert: shown === "asks" })),
      });
    };
    // What the trainer threw (in the air or on the ground).
    for (const thrown of this.pos.get("companion")?.toys ?? []) {
      const toy = toyPosition(thrown);
      if (!toy) continue;
      const x = toy.x * s;
      const y = toy.y * s;
      items.push({
        y,
        draw: () => {
          shadow(ctx, x, y, s / 2);
          this.sprites.draw(ctx, `prop.${thrown.kind}`, thrown.t < 1 ? "spin" : "default", now, x, y - Math.round(toy.lift) * s, { scale: s }); // spins in the air (if it has a `spin` animation)
        },
      });
    }
    const inAgility = session.scenario === "agility";
    dog("companion", companionSprite(session.companionLook), session.companion, inAgility ? null : trainer?.x ?? null);
    const manyPuppies = session.puppies.length > 3;
    for (const p of session.puppies) {
      dog(`p:${p.id}`, puppySprite(p), manyPuppies && p.state !== "asks" ? { ...p, detail: null } : p, trainer?.x ?? null);
    }

    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();
    for (const it of items) it.bubble?.();
  }
}
