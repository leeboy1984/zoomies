// Mega park: a single world with the six zones, one plot per session and the
// bar in the middle of the central avenue. Camera with integer zoom, drag and focus.
import { drawMap } from "./sprites.js";
import { drawBubble, drawPee, shadow } from "./scene.js";
import {
  BAR_MOTION,
  BAR_TABLES,
  BUCKET_LABEL,
  PLATFORM_BADGE,
  SEARCH_MOTION,
  TRAINER_MOTION,
  WORLD,
  agilityCourse,
  agilitySpot,
  assignPuppySpots,
  barAnim,
  barOrder,
  barSpots,
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
  plotSpots,
  puppySprite,
  puppyWorkSpot,
  HAND_WINDUP,
  setActorGoal,
  stepActor,
  throwPose,
  toyPosition,
  trainerAnim,
  trainerBubble,
  trainerFlip,
  trainerSprite,
  worldLayout,
  worldRoute,
  worldSize,
  zoneAt,
  zoneBounds,
  zoneOrigin,
} from "./model.js";

const T = 16;
const DOG_SPEED = 90;
const TRAINER_SPEED = 45;
const ZONE_LABEL = { park: "Park", forest: "Forest", snow: "Snow", square: "Square", agility: "Agility", beach: "Beach" };
/** Tiles of margin from the canvas edge where the trainer never strolls. */
const TRAINER_EDGE = 4;
const MIN_SCALE = 1;
const MAX_SCALE = 5;

const feet = ([tx, ty]) => [(tx + 0.5) * T, (ty + 1) * T];
export class World {
  constructor(canvas, sprites, maps, { onPin } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.sprites = sprites;
    this.maps = maps;
    this.onPin = onPin;
    // What each zone's terrain offers: where to mark and the agility course.
    this.terrain = Object.fromEntries(
      WORLD.zones.map((zone) => {
        const map = maps[zone];
        const o = zoneOrigin(zone);
        return [zone, map ? { marks: markSpots(map, [o.x, o.y], T), course: agilityCourse(map, [o.x, o.y], T) } : {}];
      }),
    );
    this.size = worldSize();
    this.scale = 1;
    this.camX = 0; // top-left corner of the view, in native px
    this.camY = 0;
    this.fitted = false;
    /** Full screen: the whole park as big as the screen allows, even at a fractional scale. */
    this.fill = false;
    /** The camera still shows the fitted view (no zoom or drag since), so it refits on resize. */
    this.autoFit = false;
    this.sessions = [];
    this.plots = new Map();
    this.kennel = [];
    this.pos = new Map();
    this.puppySlots = new Map(); // sessionId → Map(puppyId → slot)
    this.hits = [];
    this.bg = this.renderBackground();
    this.lawn = this.renderLawn();
    this.bindInput();
  }

  renderBackground() {
    const bg = document.createElement("canvas");
    bg.width = this.size.width * T;
    bg.height = this.size.height * T;
    const ctx = bg.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    // Avenues: the whole background is path; each zone goes on top.
    for (let y = 0; y < this.size.height; y++)
      for (let x = 0; x < this.size.width; x++) this.sprites.draw(ctx, "park.path", "default", 0, x * T, y * T);
    for (const zone of WORLD.zones) {
      const o = zoneOrigin(zone);
      const map = this.maps[zone];
      if (!map) continue;
      ctx.save();
      ctx.translate(o.x * T, o.y * T);
      drawMap(ctx, this.sprites, map, 1);
      ctx.restore();
    }
    return bg;
  }

  /**
   * Full screen: the park rarely has the screen's shape, so instead of bars
   * the lawn goes on around it (a 4×4-tile patch of grass, repeated).
   */
  renderLawn() {
    const lawn = document.createElement("canvas");
    lawn.width = 4 * T;
    lawn.height = 4 * T;
    const ctx = lawn.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    const rows = ["ghgg", "gggf", "hggg", "ggfh"];
    rows.forEach((row, y) =>
      [...row].forEach((c, x) => this.sprites.draw(ctx, `park.${{ g: "grass", h: "grass2", f: "flowers" }[c]}`, "default", 0, x * T, y * T)),
    );
    return lawn;
  }

  // ------------------------------------------------------------ state

  setSessions(sessions, { pinned, now }) {
    this.sessions = sessions;
    const { plots, kennel } = worldLayout(sessions, { pinned, now, previous: this.plots });
    this.plots = plots;
    this.kennel = kennel;
    const alive = new Set();
    const keep = (k) => alive.add(k);

    for (const s of sessions) {
      const plot = plots.get(s.id);
      if (!plot) continue;
      const spots = plotSpots(plot.zone, plot.index);
      const o = zoneOrigin(plot.zone);
      const edgeL = [(o.x - 1) * T, feet(spots.trainer)[1]];
      const edgeR = [(o.x + WORLD.zoneW) * T, feet(spots.companion)[1]];
      const tr = feet(spots.trainer);
      const ended = s.bucket === "ended";
      const working = s.bucket === "working";
      keep(`t:${s.id}`);
      const ts = displayTrainerState(s.trainer, now);
      this.place(`t:${s.id}`, ts === "enters" ? edgeL : null, ts === "leaves" ? edgeL : tr, plot.zone, TRAINER_MOTION[ts]);

      let home = feet(spots.companion);
      if (plot.zone === "agility" && this.maps.agility) {
        const [ax, ay] = agilitySpot(this.maps.agility, s.obstacles);
        if (s.obstacles > 0) home = feet([o.x + ax, o.y + ay]);
      }
      keep(`c:${s.id}`);
      const shown = displayDogState(s.companion, now, ended, working);
      // Fetching: the trainer throws something from their spot.
      const fetching = shown === "fetches";
      this.place(
        `c:${s.id}`,
        shown === "arrives" ? edgeL : null,
        shown === "leaves" ? edgeR : fetching ? fetchSpot(tr, (this.size.width * T) / 2, T) : home,
        plot.zone,
        fetching ? SEARCH_MOTION : dogMotion(shown, this.terrain[plot.zone]),
      );
      // One toy per search running in parallel.
      this.pos.get(`c:${s.id}`).wantToys = s.fetching ?? 1;

      const slots = assignPuppySpots(s.puppies, spots.puppies.length, this.puppySlots.get(s.id));
      this.puppySlots.set(s.id, slots);
      for (const p of s.puppies) {
        const key = `p:${s.id}:${p.id}`;
        keep(key);
        const slot = spots.puppies[slots.get(p.id) ?? 0];
        const work = puppyWorkSpot(p);
        const away = p.state !== "returns" && work.zone !== plot.zone;
        const dest = p.state === "returns" ? tr : away ? feet(work.spot) : feet(slot);
        const zone = away ? work.zone : plot.zone;
        this.place(key, tr, dest, zone, dogMotion(displayDogState(p, now, ended, working), this.terrain[zone]));
      }
    }

    // Bar: the trainer of every idle session goes for a drink (orders at the
    // counter and sits on the terrace) and their dog lies down to sleep beside them.
    const bar = barSpots(this.kennel.length);
    this.kennel.forEach((s, i) => {
      const seat = feet(bar.seats[i].trainer);
      const tk = `t:${s.id}`;
      keep(tk);
      keep(`c:${s.id}`);
      const fresh = !this.pos.has(tk); // was already at the bar (e.g. after a reload): seated, no ordering
      const target = fresh || this.pos.get(tk).ordered ? seat : feet(bar.counters[i % bar.counters.length]);
      this.place(tk, seat, target, null, BAR_MOTION);
      const t = this.pos.get(tk);
      t.seat = seat;
      t.standing = bar.seats[i].standing;
      if (fresh) t.ordered = true;
      this.place(`c:${s.id}`, feet(bar.seats[i].dog), feet(bar.seats[i].dog));
    });
    for (const k of [...this.pos.keys()]) if (!alive.has(k)) this.pos.delete(k);
  }

  /**
   * Creates the actor at `start` (or at its spot) and gives it a spot and a way
   * of moving. `zone` bounds where it strolls; without `motion` it stays at `target`.
   */
  place(key, start, target, zone = null, motion = null) {
    let cur = this.pos.get(key);
    if (!cur) {
      cur = newActor(start ?? target);
      this.pos.set(key, cur);
    }
    // In the middle of a lap, going to mark or bringing back a toy: new goals wait until it finishes.
    if (cur.commit || beginRetrieve(cur, motion ?? null)) {
      cur.pending = [start, target, zone, motion];
      return;
    }
    cur.zone = zone;
    cur.bounds = zone ? zoneBounds(zone, T) : null;
    // The trainer never strolls along the canvas edge (they would stare at it): only inwards.
    if (cur.bounds && key.startsWith("t:")) {
      cur.bounds.x0 = Math.max(cur.bounds.x0, TRAINER_EDGE * T);
      cur.bounds.x1 = Math.min(cur.bounds.x1, (this.size.width - TRAINER_EDGE) * T);
    }
    if (setActorGoal(cur, target, motion ?? null)) {
      cur.path = worldRoute([cur.x, cur.y], target, T);
      [cur.tx, cur.ty] = cur.path.shift();
    }
  }

  /** Can the world tile (x, y) be walked on? Avenues can. */
  walkable(x, y) {
    const at = zoneAt(x, y);
    if (!at) return true;
    const map = this.maps[at.zone];
    return !map || mapWalkable(map, at.x, at.y);
  }

  /** World ground tile at (x, y); avenues count as city ground. */
  ground(x, y) {
    const at = zoneAt(x, y);
    const map = at && this.maps[at.zone];
    return map ? groundAt(map, at.x, at.y) : "avenue";
  }

  step(dt) {
    const walkable = (x, y) => this.walkable(x, y);
    const ground = (x, y) => this.ground(x, y);
    // The whole park (never off the canvas): for throwing and searching for the toy.
    const world = { x0: T, x1: (this.size.width - 1) * T, y0: 3 * T, y1: this.size.height * T };
    const centerX = (this.size.width * T) / 2;
    for (const [key, p] of this.pos) {
      const terrain = (p.zone && this.terrain[p.zone]) || {};
      // The companion plays with its trainer (throw and fetch).
      const thrower = key.startsWith("c:") ? this.pos.get(`t:${key.slice(2)}`) : undefined;
      stepActor(p, dt, key.startsWith("t:") ? TRAINER_SPEED : DOG_SPEED, { tile: T, walkable, ground, bounds: p.bounds, thrower, world, centerX, ...terrain });
      if (!p.commit && p.pending) {
        const args = p.pending;
        p.pending = null;
        this.place(key, ...args);
      }
    }
  }

  // ------------------------------------------------------------ camera

  resize(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      if (this.autoFit) this.fitted = false;
    }
    if (!this.fitted) this.fit();
    this.clamp();
  }

  /** Full screen on or off; either way, back to the whole park. */
  setFill(fill) {
    this.fill = fill;
    this.fit();
  }

  fit() {
    const w = this.size.width * T;
    const h = this.size.height * T;
    const exact = Math.min(this.canvas.width / w, this.canvas.height / h);
    // Integer zoom keeps every pixel the same size; full screen trades that for filling the screen.
    this.scale = this.fill ? Math.max(MIN_SCALE, exact) : Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.floor(exact) || 1));
    this.camX = w / 2 - this.canvas.width / this.scale / 2;
    this.camY = h / 2 - this.canvas.height / this.scale / 2;
    this.fitted = true;
    this.autoFit = true;
    this.clamp();
  }

  clamp() {
    const vw = this.canvas.width / this.scale;
    const vh = this.canvas.height / this.scale;
    const w = this.size.width * T;
    const h = this.size.height * T;
    this.camX = vw >= w ? (w - vw) / 2 : Math.min(Math.max(this.camX, 0), w - vw);
    this.camY = vh >= h ? (h - vh) / 2 : Math.min(Math.max(this.camY, 0), h - vh);
  }

  zoomAt(delta, sx, sy) {
    // From a fractional (full screen) scale, step to the next whole one.
    const stepped = delta > 0 ? Math.floor(this.scale) + 1 : Math.ceil(this.scale) - 1;
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, stepped));
    if (next === this.scale) return;
    this.autoFit = false;
    const wx = this.camX + sx / this.scale;
    const wy = this.camY + sy / this.scale;
    this.scale = next;
    this.camX = wx - sx / next;
    this.camY = wy - sy / next;
    this.clamp();
  }

  /** Centres the camera on a session's plot (or on its trainer at the bar). */
  focus(sessionId, scale = 3) {
    const p = this.pos.get(`t:${sessionId}`) ?? this.pos.get(`c:${sessionId}`);
    if (!p) return false;
    this.autoFit = false;
    this.scale = Math.max(this.scale, scale);
    this.camX = p.x - this.canvas.width / this.scale / 2;
    this.camY = p.y - 16 - this.canvas.height / this.scale / 2;
    this.clamp();
    return true;
  }

  bindInput() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.zoomAt(e.deltaY < 0 ? 1 : -1, (e.clientX - r.left) * (c.width / r.width), (e.clientY - r.top) * (c.height / r.height));
    }, { passive: false });
    c.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, camX: this.camX, camY: this.camY, moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const r = c.getBoundingClientRect();
      const k = c.width / r.width / this.scale;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) {
        drag.moved = true;
        this.autoFit = false;
      }
      this.camX = drag.camX - dx * k;
      this.camY = drag.camY - dy * k;
      this.clamp();
    });
    c.addEventListener("pointerup", (e) => {
      if (drag && !drag.moved) {
        const r = c.getBoundingClientRect();
        this.click((e.clientX - r.left) * (c.width / r.width), (e.clientY - r.top) * (c.height / r.height));
      }
      drag = null;
    });
  }

  click(sx, sy) {
    const hit = [...this.hits].reverse().find((h) => sx >= h.x0 && sx <= h.x1 && sy >= h.y0 && sy <= h.y1);
    if (!hit) return;
    if (hit.kennel) this.onPin?.(hit.id);
    this.focus(hit.id);
  }

  // ------------------------------------------------------------ drawing

  draw(now, dt) {
    this.step(dt);
    const { ctx, scale: S } = this;
    const camX = Math.round(this.camX * S) / S;
    const camY = Math.round(this.camY * S) / S;
    const toScreen = (x, y) => [Math.round((x - camX) * S), Math.round((y - camY) * S)];
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#1f1a24";
    if (this.fill) {
      const lawn = ctx.createPattern(this.lawn, "repeat");
      lawn.setTransform(new DOMMatrix([S, 0, 0, S, -camX * S, -camY * S]));
      ctx.fillStyle = lawn;
    }
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.bg, camX, camY, this.canvas.width / S, this.canvas.height / S, 0, 0, this.canvas.width, this.canvas.height);

    const items = [];
    const hits = [];
    // Names and bubbles from ×2; full screen shows them a bit sooner (a 1080p TV is ×1.6).
    const detailed = S >= (this.fill ? 1.5 : 2);

    // Bar and terrace: all its tables set up (plus the ones further out if it gets that busy)
    const bar = barSpots(this.kennel.length);
    const [bx, by] = toScreen(...feet(bar.bar));
    items.push({ x: bx, y: by, draw: () => this.sprites.draw(ctx, "prop.bar", "default", now, bx, by, { scale: S }) });
    // Flickering neon "BAR" sign resting on the awning.
    items.push({ x: bx, y: by + 0.5, draw: () => this.sprites.draw(ctx, "prop.bar_sign", "default", now, bx, by - 27 * S, { scale: S }) });
    const tables = bar.tables(Math.max(BAR_TABLES, bar.seats.filter((seat) => !seat.standing).length));
    for (const seat of tables) {
      const [x, y] = toScreen(...feet(seat.trainer));
      items.push({ x, y: y - 1, draw: () => this.sprites.draw(ctx, "prop.chair", "default", now, x - 3 * S, y, { scale: S }) });
      items.push({ x, y: y + 1, draw: () => this.sprites.draw(ctx, "prop.table", "default", now, x + 10 * S, y, { scale: S }) });
    }

    const addTrainer = (s, t, anim, text, flip, label, kennel = false, inHand = null) => {
      const [x, y] = toScreen(t.x, t.y);
      items.push({
        x,
        y,
        draw: () => {
          shadow(ctx, x, y, S);
          this.sprites.draw(ctx, trainerSprite(s.trainerLook), anim, now, x, y, { scale: S, flip });
          // Winding up: the toy in hand, behind the head.
          if (inHand) {
            const [hx, hy] = HAND_WINDUP;
            this.sprites.draw(ctx, `toy.${inHand.kind}`, "default", now, x + (flip ? -hx : hx) * S, y + hy * S, { scale: S, flip });
          }
        },
        bubble: text ? () => drawBubble(ctx, text, x, y - 32 * S + Math.sin(now / 150) * S, Math.max(S, 2), { alert: text === "!" }) : null,
        label: label ? () => this.tag(label, x, y + 4, s) : null,
      });
      hits.push({ id: s.id, kennel, x0: x - 8 * S, x1: x + 8 * S, y0: y - 32 * S, y1: y });
    };

    const addDog = (key, sprite, actor, shown, faceX, s, label) => {
      const p = this.pos.get(key);
      // Already left the park (no standing around in the avenue) or inside the tunnel.
      if (!p || (shown === "leaves" && !p.moving) || p.act === "tunnel") return;
      const anim = dogAnim(shown, p.moving, p.fast, p.act);
      const lift = Math.round(jumpLift(p)) * S;
      // Standing at its spot it looks at the trainer; strolling, where it was heading.
      const flip = p.moving || p.motion ? p.dir < 0 : faceX !== null && faceX < p.x;
      const [x, y] = toScreen(p.x, p.y);
      // No bubble while a toy is being thrown: it would cover the trainer's wind-up.
      const text = (p.moving && !p.motion) || toyAirborne(p) ? null : dogBubble(actor, shown, now);
      const show = text && (detailed || shown === "asks" || shown === "sleeps");
      items.push({
        x,
        y,
        draw: () => {
          shadow(ctx, x, y, S);
          this.sprites.draw(ctx, sprite, anim, now, x, y - lift, { scale: S, flip });
          if (anim === "pees") drawPee(ctx, x, y, S, flip ? -1 : 1, now);
          // What the trainer threw, in its mouth.
          const held = p.toys?.find((toy) => toy.carried);
          if (held) {
            const [mx, my] = mouthOffset(sprite, anim);
            this.sprites.draw(ctx, `toy.${held.kind}`, "default", now, x + (flip ? -mx : mx) * S, y - lift + my * S, { scale: S, flip });
          }
        },
        bubble: show ? () => drawBubble(ctx, text, x, y - lift - 16 * S, Math.max(S, 2), { alert: shown === "asks" }) : null,
        label: label ? () => this.tag(label, x, y + 4, s) : null,
      });
      hits.push({ id: s.id, kennel: key.startsWith("c:") && !this.plots.has(s.id), x0: x - 8 * S, x1: x + 8 * S, y0: y - 16 * S, y1: y });
    };

    for (const s of this.sessions) {
      const plot = this.plots.get(s.id);
      const ended = s.bucket === "ended";
      const working = s.bucket === "working";
      if (!plot) continue;
      const t = this.pos.get(`t:${s.id}`);
      if (t && !(s.trainer.state === "leaves" && !t.moving)) {
        const dog = this.pos.get(`c:${s.id}`);
        const thrown = lastToy(dog);
        const pose = throwPose(thrown);
        const anim = pose ?? trainerAnim(displayTrainerState(s.trainer, now), t.moving);
        const text = trainerBubble(s.trainer);
        const label = detailed || s.bucket === "needs_you" ? s.project : null;
        addTrainer(s, t, anim, text && (detailed || text === "!") ? text : null, trainerFlip(t, dog, thrown), label, false, pose === "winds_up" ? thrown : null);
      }
      for (const thrown of this.pos.get(`c:${s.id}`)?.toys ?? []) {
        const toy = toyPosition(thrown);
        if (!toy) continue;
        const [x, y] = toScreen(toy.x, toy.y);
        items.push({
          x,
          y,
          draw: () => {
            shadow(ctx, x, y, S / 2);
            this.sprites.draw(ctx, `prop.${thrown.kind}`, thrown.t < 1 ? "spin" : "default", now, x, y - Math.round(toy.lift) * S, { scale: S }); // spins in the air (if it has a `spin` animation)
          },
        });
      }
      addDog(`c:${s.id}`, companionSprite(s.companionLook), s.companion, displayDogState(s.companion, now, ended, working), plot.zone === "agility" ? null : t?.x ?? null, s, null);
      for (const p of s.puppies) {
        const shown = displayDogState(p, now, ended, working);
        addDog(`p:${s.id}:${p.id}`, puppySprite(p), s.puppies.length > 3 && shown !== "asks" ? { ...p, detail: null } : p, shown, t?.x ?? null, s, null);
      }
    }
    for (const s of this.kennel) {
      const t = this.pos.get(`t:${s.id}`);
      if (t) {
        // At the bar: walking, ordering at the counter or holding a beer, seated or standing (and sipping now and then).
        const seated = !t.moving && t.act === "sit";
        const standing = !t.moving && t.act === "stand";
        const ordering = !t.moving && t.act === "order";
        const anim = t.moving ? "enters" : ordering ? "points" : seated || standing ? barAnim(s.id, now, standing) : "idle";
        // Seated, facing their table; standing, facing the middle of the counter.
        const flip = seated ? false : standing ? t.x > feet(bar.bar)[0] : t.dir < 0;
        addTrainer(s, t, anim, ordering ? barOrder(s.id) : null, flip, detailed ? s.project : null, true);
      }
      addDog(`c:${s.id}`, companionSprite(s.companionLook), s.companion, "sleeps", null, s, null);
    }

    // Nothing is drawn outside the view (not even bubbles stuck to the edge).
    const W = this.canvas.width;
    const H = this.canvas.height;
    const margin = 48 * S;
    const visible = items.filter((it) => it.x === undefined || (it.x > -margin && it.x < W + margin && it.y > -margin && it.y < H + margin));
    visible.sort((a, b) => a.y - b.y);
    for (const it of visible) it.draw();
    for (const it of visible) it.label?.();
    for (const it of visible) if (it.x === undefined || (it.x > 0 && it.x < W)) it.bubble?.();
    this.drawZoneLabels(toScreen);
    this.hits = hits;
  }

  tag(text, x, y, s) {
    const ctx = this.ctx;
    ctx.font = "bold 11px ui-monospace, monospace";
    // Sessions from Codex or Copilot CLI carry a small badge after the name.
    const badge = PLATFORM_BADGE[s.platform];
    const w = Math.ceil(ctx.measureText(text).width) + 8;
    const bw = badge ? Math.ceil(ctx.measureText(badge[0]).width) + 8 : 0;
    const bx = Math.round(x - (w + bw) / 2);
    ctx.fillStyle = s.bucket === "needs_you" ? "#f0c04a" : "rgba(31, 26, 36, 0.8)";
    ctx.fillRect(bx, y, w, 15);
    ctx.fillStyle = s.bucket === "needs_you" ? "#1f1a24" : "#f2dfb4";
    ctx.textBaseline = "middle";
    ctx.fillText(text, bx + 4, y + 8);
    if (badge) {
      ctx.fillStyle = badge[1];
      ctx.fillRect(bx + w, y, bw, 15);
      ctx.fillStyle = badge[2];
      ctx.fillText(badge[0], bx + w + 4, y + 8);
    }
  }

  drawZoneLabels(toScreen) {
    const ctx = this.ctx;
    ctx.font = "bold 12px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    for (const zone of WORLD.zones) {
      const o = zoneOrigin(zone);
      const [x, y] = toScreen(o.x * T + 4, o.y * T + 4);
      const text = ZONE_LABEL[zone].toUpperCase();
      const w = Math.ceil(ctx.measureText(text).width) + 10;
      ctx.fillStyle = "rgba(31, 26, 36, 0.75)";
      ctx.fillRect(x, y, w, 18);
      ctx.fillStyle = "#f2dfb4";
      ctx.fillText(text, x + 5, y + 9);
    }
  }

  /** Sessions that need the person, for the alerts bar. */
  needsYou() {
    return this.sessions.filter((s) => s.bucket === "needs_you").map((s) => ({ id: s.id, project: s.project, label: BUCKET_LABEL[s.bucket] }));
  }
}
