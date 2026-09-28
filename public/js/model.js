// Pure UI logic (no DOM): what is shown, where and in which state.
// The server is the source of truth; only visual decisions are made here:
// `sleeps` over time, which scenes fit, who goes to the bar and how everyone moves.

/** With no events for this long, the dog falls asleep (same as the server's SLEEP_AFTER_MS). */
export const SLEEP_AFTER_MS = 60_000;

/** States that never turn into `sleeps`: asking for permission must stay visible. */
const NEVER_SLEEP = new Set(["asks", "arrives", "leaves", "dashes_off", "returns"]);

/** Celebrating (when the turn ends) is a moment: after this long, back to rest. */
export const CELEBRATE_MS = 6_000;

const calmed = (actor, now) => (actor.state === "celebrates" && now - (actor.since ?? now) > CELEBRATE_MS ? "idle" : actor.state);

/**
 * State to draw for a dog (companion or puppy). It only falls asleep while the
 * session is waiting for the person: a long command or a long think inside a
 * turn (`working`) sends no events for a while, but the dog is still on duty.
 */
export function displayDogState(actor, now, ended = false, working = false) {
  if (ended || NEVER_SLEEP.has(actor.state)) return actor.state;
  if (working) return calmed(actor, now);
  return now - actor.lastEventAt > SLEEP_AFTER_MS ? "sleeps" : calmed(actor, now);
}

/** State to draw for the trainer: they don't spend the whole wait celebrating either. */
export function displayTrainerState(trainer, now) {
  return calmed(trainer, now);
}

/** Sleep depth: 1 = "z", 2 = "zZ", 3 = "zZz". 0 if not asleep. */
export function sleepDepth(actor, now) {
  const idle = now - actor.lastEventAt - SLEEP_AFTER_MS;
  if (idle <= 0) return 0;
  if (idle < 2 * 60_000) return 1;
  if (idle < 5 * 60_000) return 2;
  return 3;
}

/** Badge next to the project name for sessions that are not Claude Code: [text, background, text colour]. */
export const PLATFORM_BADGE = { codex: ["codex", "#54505e", "#fbf7ef"], copilot: ["copilot", "#3f78a8", "#fbf7ef"] };

export const BUCKET_ORDER = { needs_you: 0, working: 1, done: 2, ended: 3 };
export const BUCKET_LABEL = { needs_you: "Needs you", working: "Working", done: "Done", ended: "Closed" };

/** A done or closed session with no activity for this long goes to the bar (the kennel in the scenes view). */
export const KENNEL_AFTER_MS = 5 * 60_000;

/**
 * Splits the sessions between visible scenes (at most `max`) and the kennel.
 * Order: needs you > working > done > closed, and within each group the most
 * recent first. Sessions pinned by the person are always shown.
 */
export function arrangeScenes(sessions, { max = 4, pinned = new Set(), now = Date.now() } = {}) {
  const sorted = [...sessions].sort(
    (a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || b.lastEventAt - a.lastEventAt,
  );
  const inactive = (s) => (s.bucket === "done" || s.bucket === "ended") && now - s.lastEventAt > KENNEL_AFTER_MS;
  const visible = sorted.filter((s) => pinned.has(s.id)).slice(0, max);
  for (const s of sorted) {
    if (visible.length >= max) break;
    if (!visible.includes(s) && !inactive(s)) visible.push(s);
  }
  visible.sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || b.lastEventAt - a.lastEventAt);
  const kennel = sorted.filter((s) => !visible.includes(s));
  return { visible, kennel };
}

export const companionSprite = (look) => `dog.${look.breed}.${look.coat}`;
export const puppySprite = (p) => `pup.${p.breed}.${p.coat}`;
export const trainerSprite = (look) => (look ? `trainer.${look.style}.${look.skin}` : "trainer.cap.medium");

/** Bubble text for a dog; null = no bubble. */
export function dogBubble(actor, shown, now) {
  if (shown === "sleeps") return "zZz".slice(0, sleepDepth(actor, now) || 1);
  if (shown === "asks") return actor.detail ? `? ${actor.detail}` : "?";
  if (shown === "sad") return actor.detail ? `✗ ${actor.detail}` : null;
  if (["reads", "sniffs", "digs", "runs", "fetches", "agility"].includes(shown)) return actor.detail ?? null;
  return null;
}

/** Bubble text for the trainer. */
export function trainerBubble(trainer) {
  if (trainer.state === "points") return "!";
  if (trainer.state === "whistles") return "fweet!";
  return null;
}

/**
 * Assigns each puppy a stable map slot (in order of arrival).
 * `previous` is the previous assignment (id → index); returns the new one.
 */
export function assignPuppySpots(puppies, slots, previous = new Map()) {
  const next = new Map();
  const taken = new Set();
  for (const p of puppies) {
    const i = previous.get(p.id);
    if (i !== undefined && i < slots && !taken.has(i)) {
      next.set(p.id, i);
      taken.add(i);
    }
  }
  for (const p of [...puppies].sort((a, b) => a.startedAt - b.startedAt)) {
    if (next.has(p.id)) continue;
    for (let i = 0; i < slots; i++) {
      if (!taken.has(i)) {
        next.set(p.id, i);
        taken.add(i);
        break;
      }
    }
  }
  return next;
}

/** Companion position in agility: one obstacle per completed task (wraps around the course). */
export function agilitySpot(map, obstacles) {
  const course = map.spots.obstacles ?? [];
  if (!course.length || obstacles <= 0) return map.spots.companion;
  return course[(obstacles - 1) % course.length];
}

// ---------------------------------------------------------------- MEGA PARK
/**
 * The mega park: the six zones in a 3×2 mosaic joined by avenues, with the bar
 * in the middle of the central avenue. Each zone has 3 plots; each session
 * takes a plot in its scene's zone (or in another one if it is full).
 */
export const WORLD = {
  zoneW: 24,
  zoneH: 14,
  gap: 2,
  cols: 3,
  zones: ["park", "forest", "snow", "square", "agility", "beach"],
  /** Column (in tiles, relative to the zone) of the centre of each plot. */
  plotX: [4, 12, 20],
  /** Row of the trainer's and companion's feet. */
  plotY: 9,
};

export function worldSize() {
  const rows = Math.ceil(WORLD.zones.length / WORLD.cols);
  return {
    width: WORLD.cols * WORLD.zoneW + (WORLD.cols - 1) * WORLD.gap,
    height: rows * WORLD.zoneH + (rows - 1) * WORLD.gap,
  };
}

/** Top-left corner (in tiles) of a world zone. */
export function zoneOrigin(zone) {
  const i = WORLD.zones.indexOf(zone);
  if (i < 0) return null;
  return {
    x: (i % WORLD.cols) * (WORLD.zoneW + WORLD.gap),
    y: Math.floor(i / WORLD.cols) * (WORLD.zoneH + WORLD.gap),
  };
}

/** Positions (in world tiles) of a plot: trainer, companion and puppy slots. */
export function plotSpots(zone, index) {
  const o = zoneOrigin(zone);
  const cx = o.x + WORLD.plotX[index];
  const y = o.y + WORLD.plotY;
  return {
    trainer: [cx - 1, y],
    companion: [cx + 1, y],
    puppies: [
      [cx - 2, y + 2],
      [cx, y + 2],
      [cx + 2, y + 2],
      [cx - 1, y + 4],
      [cx + 1, y + 4],
      [cx - 2, y - 3],
      [cx, y - 3],
      [cx + 2, y - 3],
    ],
  };
}

/** Bar terrace tables (always set up): 3 on each side, what fits between the avenue crossings. */
export const BAR_TABLES = 6;
/** Standing spots at the counter (columns relative to the bar centre) when no tables are left. */
export const BAR_STANDING = [0, -1, 1, -2, 2];

/**
 * The bar, in the middle of the avenue: idle sessions send their trainer for a
 * drink. They order at the counter and sit on the terrace, with their dog
 * sleeping beside them; with no free table they stand at the counter (and
 * failing that, more tables further down the avenue). In world tiles (feet).
 */
export function barSpots(count) {
  const { width } = worldSize();
  const y = WORLD.zoneH + WORLD.gap - 1; // terrace: last row of the avenue
  const cx = Math.floor(width / 2);
  const table = (i) => {
    const side = i % 2 === 0 ? 1 : -1;
    const tx = cx + side * (4 + Math.floor(i / 2) * 3);
    return { trainer: [tx, y], dog: [tx - 1, y], standing: false };
  };
  const seats = [];
  for (let i = 0; i < count; i++) {
    if (i < BAR_TABLES) seats.push(table(i));
    else if (i < BAR_TABLES + BAR_STANDING.length) {
      const x = cx + BAR_STANDING[i - BAR_TABLES];
      seats.push({ trainer: [x, y], dog: [x - 0.6, y], standing: true }); // the dog, at their feet
    } else seats.push(table(i - BAR_STANDING.length));
  }
  // The counter takes the row above; people order in front of it (up to three at once).
  return { bar: [cx, y - 1], counters: [[cx, y], [cx - 1, y], [cx + 1, y]], seats, tables: (n) => Array.from({ length: n }, (_, i) => table(i)) };
}

/** Zone a puppy goes to work in, by its type. */
export const PUPPY_WORK_ZONE = { Explore: "forest", Plan: "square", "general-purpose": "park" };
export const PUPPY_WORK_ZONE_DEFAULT = "beach";

/** A puppy's work slot inside its work zone (stable per id). */
export function puppyWorkSpot(puppy) {
  const zone = PUPPY_WORK_ZONE[puppy.agentType] ?? PUPPY_WORK_ZONE_DEFAULT;
  const o = zoneOrigin(zone);
  let h = 0;
  for (const ch of puppy.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const col = 3 + (h % 10) * 2;
  const row = h & 1 ? 6 : 12;
  return { zone, spot: [o.x + col, o.y + row] };
}

/**
 * Assigns sessions to plots. Keeps the previous plot if it is still free; if
 * the preferred zone is full, uses the first zone with room. Idle sessions
 * (or the ones that do not fit) go to the bar.
 */
export function worldLayout(sessions, { pinned = new Set(), now = Date.now(), previous = new Map() } = {}) {
  const inactive = (s) => !pinned.has(s.id) && (s.bucket === "done" || s.bucket === "ended") && now - s.lastEventAt > KENNEL_AFTER_MS;
  const active = sessions.filter((s) => !inactive(s)).sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  const kennel = sessions.filter(inactive);
  const taken = new Set();
  const plots = new Map();
  const key = (zone, index) => `${zone}:${index}`;
  for (const s of active) {
    const prev = previous.get(s.id);
    if (prev && !taken.has(key(prev.zone, prev.index)) && (prev.zone === s.scenario || !prev.preferred)) {
      plots.set(s.id, prev);
      taken.add(key(prev.zone, prev.index));
    }
  }
  for (const s of active) {
    if (plots.has(s.id)) continue;
    const order = [s.scenario, ...WORLD.zones.filter((z) => z !== s.scenario)];
    let placed = false;
    for (const zone of order) {
      for (let index = 0; index < WORLD.plotX.length && !placed; index++) {
        if (taken.has(key(zone, index))) continue;
        plots.set(s.id, { zone, index, preferred: zone === s.scenario });
        taken.add(key(zone, index));
        placed = true;
      }
      if (placed) break;
    }
    if (!placed) kennel.push(s);
  }
  return { plots, kennel };
}

// ---------------------------------------------------------------- MOVEMENT
/**
 * How each state moves across the terrain. Radii in tiles (x, y) around its
 * spot, pauses in ms between legs, speed relative to the actor's.
 * A state without an entry stays put at its spot.
 * - wander: strolls to random points near the spot, with pauses.
 * - laps: circles around the spot (non-stop).
 * - fetch: runs far away and back to the spot, again and again.
 */
export const DOG_MOTION = {
  idle: { kind: "wander", radius: [2, 1], speed: 0.4, pause: [2500, 6000] },
  // Searching: sniffs around and, on natural ground (dirt, grass, snow, sand), digs at some stops.
  sniffs: { kind: "wander", radius: [3, 2], speed: 0.35, pause: [700, 1600], dig: 0.6 },
  // Writing: goes to mark a nearby lamp post, tree or bin (if there is none, digs where it is).
  digs: { kind: "mark", radius: [9, 8], speed: 0.8, pause: [600, 1400], pee: [2200, 3200] },
  celebrates: { kind: "wander", radius: [1, 1], speed: 0.8, pause: [300, 900] },
  runs: { kind: "laps", radius: [3, 2], speed: 1.1, pause: [0, 0] },
  agility: { kind: "laps", radius: [4, 2], speed: 1, pause: [0, 400] },
  fetches: { kind: "fetch", radius: [6, 3], speed: 1.2, pause: [300, 900] },
};
/**
 * The companion's fetch (WebFetch/WebSearch): the trainer throws a ball, bone,
 * frisbee or stick and the dog sniffs around where it landed while the search lasts.
 */
export const SEARCH_MOTION = { kind: "search", throw: [5, 14], speed: 0.45, pause: [500, 1400], dig: 0.4 };
/** When the search ends: picks up the toy and brings it to the trainer (without interruptions). */
export const RETRIEVE_MOTION = { kind: "retrieve", speed: 1.1, pause: [0, 0] };
/** What the trainer can throw (atlas props: `prop.<name>`). */
export const TOYS = ["ball", "bone", "frisbee", "stick"];

/**
 * Where the toy sits in the mouth (px relative to the feet, facing right):
 * running and sitting. Taken from each breed's snout tip.
 */
const MOUTH = {
  "dog.border_collie": [[6, -8], [4, -7]],
  "pup.border_collie": [[6, -7], [4, -6]],
  "dog.pug": [[6, -9], [4, -9]],
  "pup.pug": [[6, -8], [4, -8]],
  "dog.mutt": [[6, -8], [5, -7]],
  "pup.mutt": [[6, -7], [5, -6]],
  "dog.beagle": [[6, -8], [5, -7]],
  "pup.beagle": [[6, -7], [5, -6]],
  "dog.dachshund": [[6, -6], [4, -7]],
  "pup.dachshund": [[6, -5], [4, -6]],
};

/** Mouth position for a sprite (`dog.dachshund.red`) and an animation. */
export function mouthOffset(sprite, anim) {
  const [run, sit] = MOUTH[sprite.split(".").slice(0, 2).join(".")] ?? [[6, -7], [4, -7]];
  return anim === "asks" ? sit : run;
}

/** The trainer at the bar: orders at the counter and then sits at their table. */
export const BAR_MOTION = { kind: "bar", speed: 1, pause: [0, 0] };

/** What each trainer orders at the counter (always the same per session). */
export const BAR_ORDERS = ["a beer, please!", "a coffee!", "a vermouth!", "an orange juice!", "just water!"];
export function barOrder(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BAR_ORDERS[h % BAR_ORDERS.length];
}

/** At the bar: almost always holding the beer and, now and then, a sip (seated or standing). */
export function barAnim(id, now, standing = false) {
  let h = 0;
  for (const ch of id) h = (h * 17 + ch.charCodeAt(0)) >>> 0;
  const sip = (now + (h % 7000)) % 7000 < 1400;
  if (standing) return sip ? "stands_drinking" : "stands";
  return sip ? "drinks" : "sits";
}
/** Seconds the toy takes to land: longer the further it goes. */
export const toyFlight = (dist, tile = 16) => 0.4 + (dist / tile) * 0.055;
/** Seconds the trainer winds up (arm back, toy in hand) before releasing it. */
export const THROW_WINDUP_S = 0.3;
/** The trainer's hand (px relative to their feet, facing right): winding up and releasing. */
export const HAND_WINDUP = [-6, -26];
export const HAND_RELEASE = [6, -23];

/** The trainer's throwing pose: winding up (`winds_up`), releasing (`throws`) or null if not throwing. */
export function throwPose(toy) {
  if (!toy || toy.carried) return null;
  if (toy.hold > 0) return "winds_up";
  return toy.t < 0.3 ? "throws" : null;
}

/**
 * Which way the trainer faces (true = left): throwing, towards the throw;
 * walking, where they are going; standing, towards their dog.
 */
export function trainerFlip(trainer, dog = null, toy = null) {
  if (throwPose(toy)) return toy.dir < 0;
  if (trainer.moving || !dog) return trainer.dir < 0;
  // If it plays nearby, face where it plays (without turning on every lap); if it goes far, follow it.
  const near = Math.hypot(dog.x - trainer.x, dog.y - trainer.y) <= 4 * 16;
  const lookX = near && dog.anchor ? dog.anchor[0] : dog.x;
  if (Math.abs(lookX - trainer.x) < 2) return trainer.dir < 0;
  return lookX < trainer.x;
}

/** Agility in the agility zone: runs the course (jumps, tunnel, slalom) to the finish. */
export const COURSE_MOTION = { kind: "course", speed: 1.1, pause: [0, 0] };

/** Idle in the agility zone: strolls and, now and then, practises a lap of the course. */
export const PRACTICE_MOTION = { ...DOG_MOTION.idle, lap: 0.35 };

/** How a dog moves given its state and what its zone's terrain offers. */
export function dogMotion(state, terrain = {}) {
  if (state === "agility" && terrain.course?.length) return COURSE_MOTION;
  // With nothing to do (or celebrating the end of a turn), in agility it practises the course.
  if ((state === "idle" || state === "celebrates") && terrain.course?.length) return PRACTICE_MOTION;
  return DOG_MOTION[state] ?? null;
}

export const TRAINER_MOTION = {
  idle: { kind: "wander", radius: [2, 1], speed: 0.6, pause: [3000, 8000] },
  stopwatch: { kind: "wander", radius: [1, 1], speed: 0.5, pause: [2000, 5000] },
};

/** Ground tiles that cannot be walked on (object-layer tiles never can). */
const BLOCKING_GROUND = new Set(["water"]);

/** Can a map's tile (x, y) be walked on? Outside the map, no. */
export function mapWalkable(map, x, y) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  return map.layers.every((layer, i) => {
    const tile = map.legend[layer.rows[y]?.[x]];
    return !tile || (i === 0 && !BLOCKING_GROUND.has(tile));
  });
}

/** World zone containing tile (x, y), with local coordinates; null on the avenues. */
export function zoneAt(x, y) {
  const col = Math.floor(x / (WORLD.zoneW + WORLD.gap));
  const row = Math.floor(y / (WORLD.zoneH + WORLD.gap));
  const lx = x - col * (WORLD.zoneW + WORLD.gap);
  const ly = y - row * (WORLD.zoneH + WORLD.gap);
  const zone = WORLD.zones[row * WORLD.cols + col];
  if (col < 0 || col >= WORLD.cols || !zone || lx >= WORLD.zoneW || ly >= WORLD.zoneH) return null;
  return { zone, x: lx, y: ly };
}

/** Rectangle (px, feet) where an actor of a zone may stroll: without the top fence. */
export function zoneBounds(zone, tile = 16) {
  const o = zoneOrigin(zone);
  return { x0: (o.x + 1) * tile, x1: (o.x + WORLD.zoneW - 1) * tile, y0: (o.y + 3) * tile, y1: (o.y + WORLD.zoneH) * tile };
}

const between = ([a, b], rand) => a + (b - a) * rand();

/** Action while moving, by leg mode. */
const MOVING_ACTS = { jump: "jump", tunnel: "tunnel", sniff: "sniff", carry: "carry" };

/**
 * If the dog has thrown toys and stops searching, before anything else it goes
 * for them and brings them to the trainer, one by one. Returns true if that
 * return trip starts (new goals will have to wait until it ends).
 */
export function beginRetrieve(p, motion) {
  if (!p.toys?.length || p.retrieving || motion === SEARCH_MOTION) return false;
  p.retrieving = true;
  p.commit = true;
  p.motion = RETRIEVE_MOTION;
  p.path = [];
  p.leg = null;
  p.act = null;
  [p.tx, p.ty] = [p.x, p.y];
  p.wait = 0;
  return true;
}

/** True while a toy is still in the trainer's hand or in the air. */
export const toyAirborne = (p) => Boolean(p?.toys?.some((t) => t.hold > 0 || t.t < 1));

/**
 * Where the dog waits for the throw: one tile beside the trainer, on the side
 * the toy will fly to (towards the middle of the park), so it does not cover them.
 */
export function fetchSpot([x, y], centerX, tile = 16) {
  return [x + (centerX >= x ? 1 : -1) * tile, y + 2];
}

/** The toy the trainer threw last (for the throwing pose and where they face). */
export const lastToy = (p) => p?.toys?.[p.toys.length - 1] ?? null;

/** Position (px, feet) and height of the toy while flying or on the ground; null if it is in the mouth. */
export function toyPosition(toy) {
  if (!toy || toy.carried || toy.hold > 0) return null;
  const t = toy.t;
  return {
    x: toy.from[0] + (toy.to[0] - toy.from[0]) * t,
    y: toy.from[1] + (toy.to[1] - toy.from[1]) * t,
    // Leaves the hand (at mid height) and falls in an arc: higher the further it goes.
    lift: Math.sin(Math.PI * t) * (12 + Math.hypot(toy.to[0] - toy.from[0], toy.to[1] - toy.from[1]) / 8) + (1 - t) * -HAND_RELEASE[1],
  };
}

/** City ground: no digging there (the mega park avenues count too). */
export const CITY_GROUND = new Set(["paving", "paving2", "avenue"]);
/** Objects that can be marked: lamp posts, trees, bins (and the agility flags). */
export const MARKABLE = new Set(["tree_bottom", "pine_bottom", "palm_bottom", "lamp_bottom", "bin", "flag"]);

/** Name of a map's ground tile at (x, y). */
export function groundAt(map, x, y) {
  return map.legend[map.layers[0]?.rows[y]?.[x]] ?? null;
}

/**
 * Marking spots on a map (px, feet; `origin` in tiles): next to each markable
 * object, rear end towards it. `face` 1 = facing right.
 */
export function markSpots(map, origin = [0, 0], tile = 16) {
  const out = [];
  const obj = map.layers[1];
  if (!obj) return out;
  obj.rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (!MARKABLE.has(map.legend[ch])) return;
      for (const side of [1, -1]) {
        if (mapWalkable(map, x + side, y)) out.push({ x: (origin[0] + x + side + 0.5) * tile, y: (origin[1] + y + 1) * tile, face: side });
      }
    });
  });
  return out;
}

/**
 * Agility course (px, feet): a list of legs { to, mode, pause, act }.
 * `mode`: run, jump (arced jump: hurdles and hoop), tunnel (hidden inside the
 * tunnel). It ends celebrating at the finish and returns to the start.
 */
export function agilityCourse(map, origin = [0, 0], tile = 16) {
  const obj = map.layers[1];
  const spots = [...(map.spots?.obstacles ?? [])].sort((a, b) => a[0] - b[0]);
  if (!obj || !spots.length) return [];
  const at = (x, y) => map.legend[obj.rows[y]?.[x]] ?? null;
  const px = (x, y) => [(origin[0] + x + 0.5) * tile, (origin[1] + y + 1) * tile];
  const run = (x, y, pause = [0, 0], act = null) => ({ to: px(x, y), mode: "run", pause, act });
  const y0 = spots[0][1];
  const steps = [run(spots[0][0] - 2, y0, [500, 1000], "alert")];
  for (const [x, y] of spots) {
    const t = at(x, y);
    if (t === "hurdle" || t === "hoop") {
      steps.push(run(x - 1, y), { to: px(x + 1, y), mode: "jump", pause: [0, 150], act: null, height: t === "hoop" ? 7 : 9 });
    } else if (t === "tunnel_l") {
      let x2 = x;
      while (at(x2 + 1, y) === "tunnel_r") x2++;
      steps.push(run(x - 1, y), { to: px(x2 + 1, y), mode: "tunnel", pause: [0, 0], act: null });
    } else if (t === "slalom") {
      const [fx, fy] = px(x, y);
      steps.push(run(x - 1, y));
      for (const [dx, dy] of [[-5, -5], [0, 3], [5, -5]]) steps.push({ to: [fx + dx, fy + dy], mode: "run", pause: [0, 0], act: null });
    } else {
      steps.push(run(x, y, [1200, 2000], "celebrates")); // finish
    }
  }
  const last = spots[spots.length - 1][0];
  steps.push(run(last, y0 + 2), run(spots[0][0] - 2, y0 + 2));
  return steps;
}

/**
 * Next leg of an actor moving by `p.motion` around `p.anchor`. Returns the
 * destination (px, feet) and leaves in `p.leg` what it will do there (pause,
 * action on arrival, travel mode). Avoids blocked tiles and stays inside
 * `bounds`. `p.commit` marks an action that is not interrupted (a lap, going
 * to mark) until it is finished.
 */
export function pickWaypoint(p, env = {}, rand = Math.random) {
  const { tile = 16, walkable = () => true, bounds = null } = env;
  const m = p.motion;
  const [ax, ay] = p.anchor;
  const leg = (to, extra = {}) => {
    p.leg = { mode: "run", pause: m.pause, act: null, from: [p.x, p.y], ...extra };
    return to;
  };
  if (m.kind === "bar") {
    if (!p.ordered) return leg([p.x, p.y], { act: "order", pause: [2200, 3000], order: true });
    return leg(p.seat ?? [ax, ay], { act: p.standing ? "stand" : "sit", pause: [60_000, 60_000] });
  }
  if (m.kind === "search") {
    const from = env.thrower ? [env.thrower.x, env.thrower.y] : [ax, ay];
    // Throwing and searching happen across the whole park (other zones too), never outside.
    const area = env.world ?? bounds;
    const inside = ([x, y]) => (area ? [Math.min(Math.max(x, area.x0), area.x1), Math.min(Math.max(y, area.y0), area.y1)] : [x, y]);
    const free = ([x, y]) => walkable(Math.floor(x / tile), Math.floor((y - 1) / tile));
    // One toy per search running in parallel: another one as soon as the previous one lands.
    p.toys ??= [];
    const airborne = p.toys.some((t) => t.hold > 0 || t.t < 1);
    if (!airborne && p.toys.length < Math.max(1, p.wantToys ?? 1)) {
      // Towards the centre of the park (towards other zones), never towards the edge.
      const cx = env.centerX ?? from[0];
      const dir = Math.abs(cx - from[0]) < 2 * tile ? (rand() < 0.5 ? -1 : 1) : Math.sign(cx - from[0]);
      let to = null;
      for (let i = 0; i < 16 && !to; i++) {
        const far = m.throw[0] + rand() * (m.throw[1] - m.throw[0]) * (1 - i / 16); // if it does not land well, shorter
        const pt = inside([from[0] + dir * far * tile, from[1] + (rand() * 2 - 1) * 3 * tile]);
        if (free(pt) && Math.sign(pt[0] - from[0]) === dir) to = pt;
      }
      to ??= inside([from[0] + dir * 3 * tile, from[1]]);
      // It leaves the hand, which ends up in front of the trainer on release.
      const hand = [from[0] + dir * HAND_RELEASE[0], from[1]];
      const flight = toyFlight(Math.hypot(to[0] - hand[0], to[1] - hand[1]), tile);
      // A different toy on every throw (ball, bone, frisbee, stick…).
      p.throws = (p.throws ?? Math.floor(rand() * TOYS.length)) + 1;
      p.toys.push({ kind: TOYS[p.throws % TOYS.length], from: hand, to, t: 0, hold: THROW_WINDUP_S, flight, dir, carried: false });
      const watch = (THROW_WINDUP_S + flight) * 1000;
      return leg([p.x, p.y], { act: "alert", pause: [watch, watch], face: dir });
    }
    // Sniff around where one of the toys landed.
    const near = p.toys[Math.floor(rand() * p.toys.length)] ?? lastToy(p);
    for (let i = 0; i < 8; i++) {
      const a = rand() * 2 * Math.PI;
      const r = Math.sqrt(rand());
      const pt = inside([near.to[0] + Math.cos(a) * r * 1.5 * tile, near.to[1] + Math.sin(a) * r * tile]);
      if (free(pt)) return leg(pt, { mode: "sniff", act: "sniff", dig: m.dig });
    }
    return leg(near.to, { mode: "sniff", act: "sniff" });
  }
  if (m.kind === "retrieve") {
    const toy = p.toys?.[0];
    if (!toy) return leg([ax, ay], { end: true });
    if (!toy.carried) return leg(toy.to, { act: "pick", pause: [400, 600], pick: true });
    // Back with it in the mouth: sits next to the trainer to hand it over (and goes for the next one, if any).
    const who = env.thrower ?? { x: ax, y: ay };
    const side = p.x >= who.x ? 1 : -1;
    const last = p.toys.length === 1;
    return leg([who.x + side * tile, who.y], { mode: "carry", act: "give", pause: [800, 1100], face: -side, deliver: true, end: last });
  }
  // Course: one full lap; when practising, sometimes instead of strolling (and it finishes it).
  if (m.kind === "course" || (m.lap && env.course?.length && ((p.ci ?? 0) > 0 || rand() < m.lap))) {
    const course = env.course ?? [];
    if (!course.length) return leg([ax, ay]);
    const i = (p.ci ?? 0) % course.length;
    p.ci = i + 1;
    const step = course[i];
    p.commit = p.ci < course.length;
    if (!p.commit) p.ci = 0;
    return leg(step.to, { mode: step.mode, pause: step.pause, act: step.act, height: step.height, speed: m.lap ? COURSE_MOTION.speed : undefined });
  }
  if (m.kind === "mark") {
    p.out = !p.out;
    if (p.out) {
      const [rx, ry] = m.radius;
      const near = (env.marks ?? []).filter((s) => Math.abs(s.x - ax) <= rx * tile && Math.abs(s.y - ay) <= ry * tile);
      if (!near.length) {
        p.out = false;
        return leg([p.x, p.y], { act: "dig", pause: m.pee });
      }
      const s = near[Math.floor(rand() * near.length)];
      p.commit = true;
      return leg([s.x, s.y], { act: "pee", face: s.face, pause: m.pee, end: true });
    }
  }
  if (m.kind === "fetch") {
    p.out = !p.out;
    if (!p.out) return leg([ax, ay]);
  }
  for (let i = 0; i < 8; i++) {
    let a;
    let r;
    if (m.kind === "laps") {
      p.angle = (p.angle ?? rand() * 2 * Math.PI) + Math.PI / 4 + (rand() * Math.PI) / 4;
      a = p.angle;
      r = 1;
    } else {
      a = rand() * 2 * Math.PI;
      r = m.kind === "fetch" ? 0.6 + 0.4 * rand() : Math.sqrt(rand());
    }
    // After marking, back to sniffing near its spot.
    const [rx, ry] = m.kind === "mark" ? [2, 1] : m.radius;
    let x = ax + Math.cos(a) * r * rx * tile;
    let y = ay + Math.sin(a) * r * ry * tile;
    if (bounds) {
      x = Math.min(Math.max(x, bounds.x0), bounds.x1);
      y = Math.min(Math.max(y, bounds.y0), bounds.y1);
    }
    if (walkable(Math.floor(x / tile), Math.floor((y - 1) / tile))) return leg([x, y], { dig: m.dig ?? 0 });
  }
  return leg([ax, ay]);
}

/**
 * Moves an actor `p` ({ x, y, tx, ty, anchor, motion, … }) towards its target.
 * With a `motion`, on arrival it does the leg's action (digging, peeing,
 * celebrating…) during the pause and picks the next leg. `p.act` is the
 * current action (also `jump`/`tunnel` while moving); `p.dir` keeps the last
 * horizontal direction so it does not turn around when it stops.
 */
export function stepActor(p, dt, speed, env = {}, rand = Math.random) {
  const tile = env.tile ?? 16;
  const dx = p.tx - p.x;
  const dy = p.ty - p.y;
  const d = Math.hypot(dx, dy);
  // On the way (along avenues or far from its strolling area): normal pace.
  const base = p.leg?.speed ?? p.motion?.speed ?? 1;
  const k = p.motion && d < 4 * tile && !p.path?.length ? base : Math.max(1, base);
  const move = speed * k * dt;
  p.moving = d > 0.5;
  p.fast = k >= 1;
  if (Math.abs(dx) > 0.5) p.dir = dx < 0 ? -1 : 1;
  for (const toy of p.toys ?? []) {
    if (toy.hold > 0) toy.hold -= dt; // still in the trainer's hand
    else if (toy.t < 1) toy.t = Math.min(1, toy.t + dt / toy.flight);
  }
  p.act = p.moving ? MOVING_ACTS[p.leg?.mode] ?? null : p.act;
  if (d <= move) {
    p.x = p.tx;
    p.y = p.ty;
    if (p.path?.length) {
      [p.tx, p.ty] = p.path.shift();
      p.moving = true; // intermediate waypoint: keep walking
    }
  } else {
    p.x += (dx / d) * move;
    p.y += (dy / d) * move;
  }
  if (p.moving || !p.motion) return;
  if (p.wait == null) {
    const leg = p.leg ?? { pause: p.motion.pause, act: null };
    p.wait = between(leg.pause, rand);
    p.act = leg.act;
    if (leg.dig && rand() < leg.dig && !CITY_GROUND.has(env.ground?.(Math.floor(p.x / tile), Math.floor((p.y - 1) / tile)))) p.act = "dig";
    if (leg.face) p.dir = leg.face;
  }
  p.wait -= dt * 1000;
  if (p.wait <= 0) {
    if (p.leg?.pick) p.toys[0].carried = true;
    if (p.leg?.order) p.ordered = true;
    if (p.leg?.deliver) p.toys.shift();
    if (p.leg?.end) {
      p.commit = false;
      p.retrieving = false;
    }
    p.act = null;
    p.leg = null;
    [p.tx, p.ty] = pickWaypoint(p, env, rand);
    p.wait = null;
    // No pause between legs: keep going (no stopped frame in between).
    p.moving = Math.hypot(p.tx - p.x, p.ty - p.y) > 0.5;
    if (p.moving) p.act = MOVING_ACTS[p.leg?.mode] ?? null;
  }
}

/** Height (native px) of the current jump: an arc over the leg's progress. */
export function jumpLift(p) {
  if (p.act !== "jump" || !p.leg?.from) return 0;
  const total = Math.hypot(p.tx - p.leg.from[0], p.ty - p.leg.from[1]);
  const left = Math.hypot(p.tx - p.x, p.ty - p.y);
  const t = total > 0 ? 1 - left / total : 1;
  return Math.sin(Math.PI * Math.min(Math.max(t, 0), 1)) * (p.leg.height ?? 8);
}

/**
 * Gives an actor a spot (`target`) and a way of moving. Without `motion`, it
 * goes straight to the spot and stays. With `motion`, it moves around it and,
 * if the spot or the kind of movement changes, starts the new pattern right away.
 */
export function setActorGoal(p, target, motion = null) {
  const moved = !p.anchor || Math.hypot(target[0] - p.anchor[0], target[1] - p.anchor[1]) > 1;
  const changed = motion !== p.motion;
  p.anchor = target;
  p.motion = motion;
  if (moved) p.path = [];
  if (!motion) {
    if (moved || !p.path?.length) [p.tx, p.ty] = target;
    p.wait = null;
  } else if (moved) {
    [p.tx, p.ty] = target;
    p.wait = 0;
  } else if (changed && !p.path?.length) {
    [p.tx, p.ty] = [p.x, p.y];
    p.wait = 0;
    p.out = false;
  }
  if (changed) p.ordered = false;
  if (moved || changed) {
    p.commit = false;
    p.ci = 0;
    p.leg = null;
    p.act = null;
  }
  return moved;
}

/**
 * Path (px, feet) from `from` to `to` in the mega park: going from one zone to
 * another, actors walk down or up to the central avenue, along it and into the
 * target zone, instead of crossing other zones over fences and trees.
 */
export function worldRoute(from, to, tile = 16) {
  const zoneOf = ([x, y]) => zoneAt(Math.floor(x / tile), Math.floor((y - 1) / tile))?.zone ?? null;
  const a = zoneOf(from);
  const b = zoneOf(to);
  const avenueY = (WORLD.zoneH + WORLD.gap) * tile - tile / 2;
  // Between a zone and the central avenue (to the bar and back): along the avenue, not diagonally.
  const central = ([, y]) => Math.abs(y - avenueY) <= tile;
  if (a && !b) return central(to) ? [[from[0], avenueY], to] : [to];
  if (!a && b) return central(from) ? [[to[0], avenueY], to] : [to];
  if (!a || a === b) return [to];
  return [[from[0], avenueY], [to[0], avenueY], to];
}

/** Creates an actor at `start` (or already at its spot). */
export function newActor(start) {
  const [x, y] = start;
  return { x, y, tx: x, ty: y, moving: false, fast: false, dir: 1, anchor: null, motion: null, wait: null, toys: [] };
}

/** Trainer animation: only walks if actually moving. */
export function trainerAnim(state, moving) {
  if (moving) return "enters";
  return state === "enters" || state === "leaves" ? "idle" : state;
}

/** States with their own travel animation (kept while moving). */
const DOG_MOVE_ANIMS = new Set(["runs", "fetches", "agility", "sniffs", "celebrates", "dashes_off", "returns"]);
/** States that are only about going somewhere: when stopped, shown at rest. */
const DOG_TRANSIT = new Set(["arrives", "leaves", "returns", "dashes_off"]);
/** Running states: during pauses, panting and alert. */
const DOG_RUNS = new Set(["runs", "fetches", "agility"]);

/** Animation for each terrain action. */
const ACT_ANIMS = {
  pee: "pees",
  jump: "jumps",
  dig: "digs",
  celebrates: "celebrates",
  alert: "alert",
  sniff: "sniffs",
  pick: "sniffs",
  carry: "runs", // with the toy in its mouth (drawn separately)
  give: "asks", // sitting in front of the trainer
};

/**
 * Dog animation: the current action (peeing, jumping, digging…) wins; otherwise
 * it walks/runs only if it is moving. Asleep, always sleeps.
 */
export function dogAnim(shown, moving, fast, act = null) {
  if (act && ACT_ANIMS[act] && shown !== "sleeps") return ACT_ANIMS[act];
  if (moving) return DOG_MOVE_ANIMS.has(shown) ? shown : fast ? "runs" : "arrives";
  if (DOG_TRANSIT.has(shown)) return "idle";
  if (DOG_RUNS.has(shown)) return "alert";
  return shown;
}
