import { describe, expect, it } from "vitest";
// Pure frontend logic (public/js/model.js): tested in Node without a DOM.
import {
  SLEEP_AFTER_MS,
  agilitySpot,
  arrangeScenes,
  assignPuppySpots,
  displayDogState,
  dogBubble,
  sleepDepth,
  trainerBubble,
} from "../public/js/model.js";
import { SLEEP_AFTER_MS as SERVER_SLEEP_AFTER_MS } from "../src/mapping/table.js";

const now = 10_000_000;
const actor = (state: string, idleMs = 0, detail: string | null = null) => ({ state, lastEventAt: now - idleMs, detail });
const session = (id: string, bucket: string, idleMs: number) => ({ id, bucket, lastEventAt: now - idleMs });

describe("sleeps and asks (UI)", () => {
  it("uses the same threshold as the server", () => {
    expect(SLEEP_AFTER_MS).toBe(SERVER_SLEEP_AFTER_MS);
  });

  it("falls asleep after 60 s without events, deeper and deeper", () => {
    expect(displayDogState(actor("idle", 59_000), now)).toBe("idle");
    expect(displayDogState(actor("celebrates", 61_000), now)).toBe("sleeps");
    expect(sleepDepth(actor("idle", 61_000), now)).toBe(1);
    expect(sleepDepth(actor("idle", SLEEP_AFTER_MS + 3 * 60_000), now)).toBe(2);
    expect(sleepDepth(actor("idle", SLEEP_AFTER_MS + 10 * 60_000), now)).toBe(3);
    expect(dogBubble(actor("idle", SLEEP_AFTER_MS + 10 * 60_000), "sleeps", now)).toBe("zZz");
  });

  it("asking for permission never turns into sleeping and carries its bubble", () => {
    const a = actor("asks", 10 * 60_000, "Bash: rm -rf x");
    expect(displayDogState(a, now)).toBe("asks");
    expect(dogBubble(a, "asks", now)).toBe("? Bash: rm -rf x");
    expect(trainerBubble({ state: "points" })).toBe("!");
  });

  it("a closed session does not fall asleep (the dog has already left)", () => {
    expect(displayDogState(actor("leaves", 10 * 60_000), now, true)).toBe("leaves");
  });

  it("tool bubbles with the real detail", () => {
    expect(dogBubble(actor("reads", 0, "login.ts"), "reads", now)).toBe("login.ts");
    expect(dogBubble(actor("idle", 0, "login.ts"), "idle", now)).toBeNull();
  });
});

describe("visible scenes and kennel", () => {
  it("sorts by urgency and limits the visible ones", () => {
    const list = [session("a", "done", 1000), session("b", "needs_you", 5000), session("c", "working", 2000), session("d", "working", 100)];
    const { visible, kennel } = arrangeScenes(list, { max: 3, now });
    expect(visible.map((s) => s.id)).toEqual(["b", "d", "c"]);
    expect(kennel.map((s) => s.id)).toEqual(["a"]);
  });

  it("sends idle sessions to the kennel even if there is room", () => {
    const { visible, kennel } = arrangeScenes([session("a", "done", 6 * 60_000), session("b", "working", 6 * 60_000)], { max: 4, now });
    expect(visible.map((s) => s.id)).toEqual(["b"]);
    expect(kennel.map((s) => s.id)).toEqual(["a"]);
  });

  it("sessions pinned by the person are always shown", () => {
    const list = [session("a", "ended", 60 * 60_000), session("b", "working", 0), session("c", "working", 0)];
    const { visible } = arrangeScenes(list, { max: 2, pinned: new Set(["a"]), now });
    expect(visible.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });
});

describe("placement", () => {
  it("each puppy keeps its slot", () => {
    const p = (id: string, startedAt: number) => ({ id, startedAt });
    const first = assignPuppySpots([p("x", 1), p("y", 2)], 8);
    expect([...first]).toEqual([["x", 0], ["y", 1]]);
    const second = assignPuppySpots([p("y", 2), p("z", 3)], 8, first);
    expect(second.get("y")).toBe(1);
    expect(second.get("z")).toBe(0);
  });

  it("agility: one obstacle per completed task, wrapping around the course", () => {
    const map = { spots: { companion: [0, 0], obstacles: [[1, 1], [2, 2], [3, 3]] } };
    expect(agilitySpot(map, 0)).toEqual([0, 0]);
    expect(agilitySpot(map, 2)).toEqual([2, 2]);
    expect(agilitySpot(map, 4)).toEqual([1, 1]);
  });
});

describe("mega park", async () => {
  const { WORLD, barSpots, plotSpots, puppyWorkSpot, worldLayout, worldSize, zoneOrigin } = await import("../public/js/model.js");
  const s = (id: string, scenario: string, startedAt: number, bucket = "working", idleMs = 0) => ({ id, scenario, startedAt, bucket, lastEventAt: now - idleMs });

  it("lays out the 6 zones in 3×2 with avenues", () => {
    expect(worldSize()).toEqual({ width: 3 * 24 + 2 * 2, height: 2 * 14 + 2 });
    expect(zoneOrigin("park")).toEqual({ x: 0, y: 0 });
    expect(zoneOrigin("beach")).toEqual({ x: 52, y: 16 });
    expect(WORLD.zones).toHaveLength(6);
  });

  it("each session goes to a plot in its zone; if full, to another one", () => {
    const list = [s("a", "forest", 1), s("b", "forest", 2), s("c", "forest", 3), s("d", "forest", 4)];
    const { plots, kennel } = worldLayout(list, { now });
    expect(["a", "b", "c"].map((id) => plots.get(id)?.zone)).toEqual(["forest", "forest", "forest"]);
    expect(plots.get("d")?.zone).not.toBe("forest");
    expect(kennel).toEqual([]);
  });

  it("keeps the previous plot and sends idle sessions to the bar", () => {
    const first = worldLayout([s("a", "park", 1), s("b", "park", 2)], { now }).plots;
    const again = worldLayout([s("b", "park", 2), s("a", "park", 1)], { now, previous: first }).plots;
    expect(again.get("a")).toEqual(first.get("a"));
    const { plots, kennel } = worldLayout([s("z", "park", 1, "done", 10 * 60_000)], { now });
    expect(plots.size).toBe(0);
    expect(kennel.map((x) => x.id)).toEqual(["z"]);
  });

  it("a session that changes scene (e.g. to agility) moves zone", () => {
    const first = worldLayout([s("a", "park", 1)], { now }).plots;
    const moved = worldLayout([s("a", "agility", 1)], { now, previous: first }).plots;
    expect(moved.get("a")?.zone).toBe("agility");
  });

  it("plots, bar and work slots fall inside the world", () => {
    const { width, height } = worldSize();
    const inside = ([x, y]: number[]) => x >= 0 && y >= 0 && x < width && y < height;
    for (const zone of WORLD.zones) for (let i = 0; i < 3; i++) {
      const p = plotSpots(zone, i);
      expect([p.trainer, p.companion, ...p.puppies].every(inside)).toBe(true);
    }
    const b = barSpots(6);
    expect([b.bar, ...b.counters, ...b.seats.flatMap((s: any) => [s.trainer, s.dog])].every(inside)).toBe(true);
    expect(puppyWorkSpot({ id: "agent-1", agentType: "Explore" }).zone).toBe("forest");
    expect(inside(puppyWorkSpot({ id: "x", agentType: "other" }).spot)).toBe(true);
  });
});

describe("movement across the terrain", async () => {
  const { DOG_MOTION, TRAINER_MOTION, dogAnim, mapWalkable, newActor, pickWaypoint, setActorGoal, stepActor, trainerAnim, zoneAt } =
    await import("../public/js/model.js");
  const seq = (...xs: number[]) => {
    let i = 0;
    return () => xs[i++ % xs.length] as number;
  };
  const run = (p: ReturnType<typeof newActor>, secs: number, env = {}) => {
    for (let t = 0; t < secs; t += 0.05) stepActor(p, 0.05, 90, env, seq(0.1, 0.5, 0.9, 0.3, 0.7));
  };

  it("once at its spot it no longer plays the walking animation", () => {
    expect(trainerAnim("enters", true)).toBe("enters");
    expect(trainerAnim("enters", false)).toBe("idle");
    expect(trainerAnim("notebook", false)).toBe("notebook");
    expect(dogAnim("arrives", false, false)).toBe("idle");
    expect(dogAnim("runs", false, true)).toBe("alert");
    expect(dogAnim("reads", false, false)).toBe("reads");
    expect(dogAnim("idle", true, false)).toBe("arrives");
    expect(dogAnim("asks", true, true)).toBe("runs");
    expect(dogAnim("sniffs", true, false)).toBe("sniffs");
  });

  it("without motion it goes to its spot and stays", () => {
    const p = newActor([0, 100]);
    setActorGoal(p, [100, 100], null);
    run(p, 3);
    expect([p.x, p.y, p.moving]).toEqual([100, 100, false]);
  });

  it("with motion it moves across the terrain without straying from its spot", () => {
    const p = newActor([200, 200]);
    setActorGoal(p, [200, 200], DOG_MOTION.runs);
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      run(p, 0.1);
      seen.add(`${Math.round(p.x / 16)},${Math.round(p.y / 16)}`);
      expect(Math.abs(p.x - 200)).toBeLessThanOrEqual(3 * 16 + 1);
      expect(Math.abs(p.y - 200)).toBeLessThanOrEqual(2 * 16 + 1);
    }
    expect(seen.size).toBeGreaterThan(3);
    expect(TRAINER_MOTION.idle.kind).toBe("wander");
  });

  it("fetch: goes far away and back to its spot", () => {
    const p = { ...newActor([200, 200]), anchor: [200, 200], motion: DOG_MOTION.fetches };
    const out = pickWaypoint(p, {}, seq(0, 0));
    expect(Math.hypot(out[0] - 200, out[1] - 200)).toBeGreaterThan(3 * 16);
    expect(pickWaypoint(p, {}, seq(0, 0))).toEqual([200, 200]);
  });

  it("never steps on blocked tiles or leaves its bounds", () => {
    const p = { ...newActor([200, 200]), anchor: [200, 200], motion: DOG_MOTION.sniffs };
    const bounds = { x0: 190, x1: 230, y0: 180, y1: 210 };
    for (let i = 0; i < 50; i++) {
      const [x, y] = pickWaypoint(p, { walkable: (tx: number) => tx !== 13, bounds });
      expect(Math.floor(x / 16)).not.toBe(13);
      expect(x >= 190 && x <= 230 && y >= 180 && y <= 210).toBe(true);
    }
  });

  it("maps: objects and water block; world zones", () => {
    const map = { width: 3, height: 1, legend: { g: "grass", a: "water", T: "tree", ".": null }, layers: [{ rows: ["gga"] }, { rows: [".T."] }] };
    expect([0, 1, 2].map((x) => mapWalkable(map, x, 0))).toEqual([true, false, false]);
    expect(mapWalkable(map, 5, 0)).toBe(false);
    expect(zoneAt(0, 0)).toEqual({ zone: "park", x: 0, y: 0 });
    expect(zoneAt(24, 0)).toBeNull(); // avenue
    expect(zoneAt(53, 17)).toEqual({ zone: "beach", x: 1, y: 1 });
  });
});

describe("terrain actions", async () => {
  const { COURSE_MOTION, DOG_MOTION, agilityCourse, dogAnim, dogMotion, jumpLift, markSpots, newActor, setActorGoal, stepActor } =
    await import("../public/js/model.js");
  const { readFileSync } = await import("node:fs");
  const agility = JSON.parse(readFileSync(new URL("../public/art/maps/agility.json", import.meta.url), "utf8"));
  const run = (p: any, secs: number, env: any, rand = () => 0.5) => {
    const seen: any[] = [];
    for (let t = 0; t < secs; t += 0.05) {
      stepActor(p, 0.05, 90, env, rand);
      seen.push({ act: p.act, lift: jumpLift(p), commit: !!p.commit, x: p.x, y: p.y, dir: p.dir });
    }
    return seen;
  };

  it("actions override the animation", () => {
    expect(dogAnim("digs", false, false, "pee")).toBe("pees");
    expect(dogAnim("agility", true, true, "jump")).toBe("jumps");
    expect(dogAnim("sniffs", false, false, "dig")).toBe("digs");
    expect(dogAnim("sleeps", false, false, "pee")).toBe("sleeps");
  });

  it("agility uses the course only where there is one", () => {
    expect(dogMotion("agility", { course: agilityCourse(agility) })).toBe(COURSE_MOTION);
    expect(dogMotion("agility", {})).toBe(DOG_MOTION.agility);
    expect(dogMotion("reads")).toBeNull();
  });

  it("the course jumps hurdles and the hoop, goes hidden through the tunnel and celebrates at the finish", () => {
    const course = agilityCourse(agility);
    expect(course.filter((s: any) => s.mode === "jump")).toHaveLength(3); // hurdle, hoop, hurdle
    expect(course.filter((s: any) => s.mode === "tunnel")).toHaveLength(1);
    expect(course.some((s: any) => s.act === "celebrates")).toBe(true);
    const p = newActor(course[0].to);
    setActorGoal(p, course[0].to, COURSE_MOTION);
    const seen = run(p, 8, { course });
    expect(seen.some((f) => f.act === "jump" && f.lift > 5)).toBe(true);
    expect(seen.some((f) => f.act === "tunnel")).toBe(true);
    expect(seen.some((f) => f.act === "celebrates")).toBe(true);
  });

  it("a lap of the course is not cut short when the state changes", () => {
    const course = agilityCourse(agility);
    const p = newActor(course[0].to);
    setActorGoal(p, course[0].to, COURSE_MOTION);
    run(p, 1, { course });
    expect(p.commit).toBe(true);
  });

  it("when writing it goes to mark next to a tree, rear end towards it", () => {
    const map = { width: 6, height: 3, legend: { g: "grass", R: "tree_bottom", ".": null }, layers: [{ rows: ["gggggg", "gggggg", "gggggg"] }, { rows: ["......", "..R...", "......"] }] };
    const marks = markSpots(map);
    expect(marks).toEqual([{ x: 3.5 * 16, y: 32, face: 1 }, { x: 1.5 * 16, y: 32, face: -1 }]);
    const p = newActor([5.5 * 16, 48]);
    setActorGoal(p, [5.5 * 16, 48], DOG_MOTION.digs);
    const seen = run(p, 6, { marks });
    const pee = seen.filter((f) => f.act === "pee");
    expect(pee.length).toBeGreaterThan(20); // about 2-3 s
    expect(pee.every((f) => marks.some((m: any) => m.x === f.x && m.y === f.y && m.face === f.dir))).toBe(true);
    // Then it goes back to sniffing near its spot before marking again.
    const after = seen.slice(seen.findIndex((f) => f.act === "pee") + pee.length);
    expect(after.some((f) => Math.hypot(f.x - 5.5 * 16, f.y - 48) <= 2 * 16 + 1)).toBe(true);
  });

  it("with nothing to mark it digs; when searching, it only digs outside the city", () => {
    const p = newActor([50, 50]);
    setActorGoal(p, [50, 50], DOG_MOTION.digs);
    expect(run(p, 1, { marks: [] }).some((f) => f.act === "dig")).toBe(true);
    const sniff = (ground: string) => {
      const q = newActor([50, 50]);
      setActorGoal(q, [50, 50], DOG_MOTION.sniffs);
      return run(q, 6, { ground: () => ground }, () => 0.1).some((f) => f.act === "dig");
    };
    expect(sniff("snow")).toBe(true);
    expect(sniff("paving")).toBe(false);
  });
});

describe("throw and fetch", async () => {
  const { SEARCH_MOTION, DOG_MOTION, beginRetrieve, dogAnim, newActor, setActorGoal, stepActor, toyPosition } = await import("../public/js/model.js");
  const thrower = { x: 160, y: 160 };
  const run = (p: any, secs: number) => {
    const seen: any[] = [];
    for (let t = 0; t < secs; t += 0.05) {
      stepActor(p, 0.05, 90, { thrower }, () => 0.3);
      seen.push({ act: p.act, anim: dogAnim("fetches", p.moving, p.fast, p.act), toy: p.toys[0] && { ...p.toys[0] }, x: p.x, y: p.y });
    }
    return seen;
  };

  const run2 = (p: any, env: any) => {
    for (let t = 0; t < 0.5; t += 0.05) stepActor(p, 0.05, 90, env);
  };

  it("the trainer throws, the dog sniffs where it lands and, when done, brings it back in its mouth", () => {
    const p = newActor([170, 160]);
    setActorGoal(p, [thrower.x, thrower.y], SEARCH_MOTION);
    const searching = run(p, 5);
    const toy = p.toys[0];
    expect(toy && toy.t).toBe(1);
    expect(Math.hypot(toy.to[0] - thrower.x, toy.to[1] - thrower.y)).toBeGreaterThan(2 * 16);
    expect(searching.some((f) => f.toy && f.toy.t > 0 && f.toy.t < 1 && toyPosition(f.toy)!.lift > 10)).toBe(true); // flying
    expect(searching.some((f) => f.anim === "sniffs" && Math.hypot(f.x - toy.to[0], f.y - toy.to[1]) <= 2 * 16)).toBe(true);

    // The search ends: new goals wait until the toy is back.
    expect(beginRetrieve(p, DOG_MOTION.idle)).toBe(true);
    const back = run(p, 6);
    expect(back.some((f) => f.anim === "runs" && f.toy?.carried)).toBe(true); // on the way back, toy in its mouth
    const give = back.filter((f) => f.anim === "asks");
    expect(give.length).toBeGreaterThan(5); // sitting while handing it over
    expect(Math.hypot(give[0].x - thrower.x, give[0].y - thrower.y)).toBeLessThanOrEqual(16 + 1);
    expect(p.toys).toEqual([]);
    expect(p.commit).toBe(false);
  });

  it("throws towards the centre of the park (sometimes into another zone), never outwards", () => {
    const world = { x0: 16, x1: 75 * 16, y0: 48, y1: 30 * 16 };
    const nearLeftEdge = { x: 3.5 * 16, y: 160 };
    for (let i = 0; i < 50; i++) {
      const p: any = newActor([nearLeftEdge.x + 16, nearLeftEdge.y]);
      setActorGoal(p, [nearLeftEdge.x, nearLeftEdge.y], SEARCH_MOTION);
      run2(p, { thrower: nearLeftEdge, world, centerX: 38 * 16 });
      const [x, y] = p.toys[0].to;
      expect(x).toBeGreaterThan(nearLeftEdge.x); // inwards
      expect(x >= world.x0 && x <= world.x1 && y >= world.y0 && y <= world.y1).toBe(true);
      expect(p.dir).toBe(1); // the dog looks where it flies
    }
  });

  it("with nothing thrown there is nothing to fetch", () => {
    const p = newActor([0, 0]);
    expect(beginRetrieve(p, DOG_MOTION.idle)).toBe(false);
  });
});

describe("bar", async () => {
  const { WORLD, BAR_MOTION, BAR_ORDERS, barAnim, barOrder, barSpots, mouthOffset, newActor, setActorGoal, stepActor, worldRoute, worldSize } =
    await import("../public/js/model.js");

  it("terrace tables never overlap each other or the counter", () => {
    const { bar, seats } = barSpots(8);
    const cols = seats.filter((s: any) => !s.standing).flatMap((s: any) => [s.dog[0], s.trainer[0], s.trainer[0] + 1]);
    expect(new Set(cols).size).toBe(cols.length);
    expect(cols.every((x: number) => Math.abs(x - bar[0]) >= 2)).toBe(true);
    expect(seats.every((s: any) => s.trainer[1] === worldSize().height / 2)).toBe(true); // on the central avenue
  });

  it("6 tables between the crossings; with no free table, standing at the counter; after that, more tables down the avenue", () => {
    const { bar, seats, tables } = barSpots(12);
    expect(seats.slice(0, 6).every((s: any) => !s.standing)).toBe(true);
    expect(seats.slice(6, 11).every((s: any) => s.standing && Math.abs(s.trainer[0] - bar[0]) <= 2)).toBe(true);
    expect(seats[11].standing).toBe(false);
    const xs = seats.map((s: any) => s.trainer[0]);
    expect(new Set(xs).size).toBe(12); // nobody in someone else's spot
    // The 6 tables (with their dog and little table) stay between the two avenue crossings.
    const tramo = [WORLD.zoneW + WORLD.gap, 2 * WORLD.zoneW + WORLD.gap - 1];
    expect(tables(6).every((s: any) => s.dog[0] >= tramo[0] && s.trainer[0] + 1 <= tramo[1])).toBe(true);
    expect(["stands", "stands_drinking"]).toContain(barAnim("s", 0, true));
  });

  it("the trainer orders at the counter and then sits at their table", () => {
    const counter = [100, 256];
    const seat = [180, 256];
    const p: any = newActor(counter);
    setActorGoal(p, counter, BAR_MOTION);
    p.seat = seat;
    const acts: string[] = [];
    for (let t = 0; t < 8; t += 0.05) {
      stepActor(p, 0.05, 45, {}, () => 0.5);
      if (p.act && acts[acts.length - 1] !== p.act) acts.push(p.act);
    }
    expect(acts).toEqual(["order", "sit"]);
    expect([p.x, p.y]).toEqual(seat);
    expect(BAR_ORDERS).toContain(barOrder("sesion-1"));
    expect(barOrder("sesion-1")).toBe(barOrder("sesion-1"));
    const anims = new Set(Array.from({ length: 70 }, (_, i) => barAnim("sesion-1", i * 100)));
    expect([...anims].sort()).toEqual(["drinks", "sits"]);
  });

  it("walks to the bar along the avenue, not diagonally through other zones", () => {
    const route = worldRoute([4.5 * 16, 10 * 16], [38.5 * 16, 16 * 16]);
    expect(route).toHaveLength(2);
    expect(route[0][0]).toBe(4.5 * 16);
    // entering from the side of the park is still direct
    expect(worldRoute([-16, 160], [72, 160])).toEqual([[72, 160]]);
  });

  it("the toy sits in every breed's mouth, running or sitting", () => {
    expect(mouthOffset("dog.dachshund.red", "runs")).toEqual([6, -6]);
    expect(mouthOffset("pup.dachshund.red", "asks")).toEqual([4, -6]);
    expect(mouthOffset("dog.nueva.raza", "runs")).toEqual([6, -7]);
  });
});

describe("celebrating is a moment", async () => {
  const { CELEBRATE_MS, displayDogState, displayTrainerState } = await import("../public/js/model.js");
  it("a while after finishing, trainer and dog go back to rest (and then the dog falls asleep)", () => {
    const t0 = 1_000_000;
    const a = { state: "celebrates", since: t0, lastEventAt: t0, detail: null };
    expect(displayTrainerState(a, t0 + 1000)).toBe("celebrates");
    expect(displayDogState(a, t0 + 1000)).toBe("celebrates");
    expect(displayTrainerState(a, t0 + CELEBRATE_MS + 1)).toBe("idle");
    expect(displayDogState(a, t0 + CELEBRATE_MS + 1)).toBe("idle");
    expect(displayDogState(a, t0 + 61_000)).toBe("sleeps");
    expect(displayTrainerState(a, t0 + 61_000)).toBe("idle");
  });
});

describe("the trainer faces their dog and throws in two beats", async () => {
  const { SEARCH_MOTION, THROW_WINDUP_S, newActor, setActorGoal, stepActor, throwPose, toyPosition, trainerFlip } = await import("../public/js/model.js");

  it("standing, faces their dog even if their last step went the other way", () => {
    const trainer = { x: 100, y: 100, moving: false, dir: -1 };
    expect(trainerFlip(trainer, { x: 140 })).toBe(false); // dog on the right: faces right
    expect(trainerFlip({ ...trainer, dir: 1 }, { x: 60 })).toBe(true);
    expect(trainerFlip({ ...trainer, moving: true }, { x: 140 })).toBe(true); // walking, where they are going
  });

  it("winds up with the toy in hand, releases it and it flies; meanwhile faces the throw", () => {
    const thrower = { x: 160, y: 160, moving: false, dir: 1 };
    const p: any = newActor([176, 160]);
    setActorGoal(p, [160, 160], SEARCH_MOTION);
    const poses: (string | null)[] = [];
    let flying = false;
    for (let t = 0; t < 3; t += 0.05) {
      stepActor(p, 0.05, 90, { thrower, centerX: 38 * 16 }, () => 0.5);
      const toy = p.toys[0];
      const pose = throwPose(toy);
      if (poses[poses.length - 1] !== pose) poses.push(pose);
      if (pose === "winds_up") expect(toyPosition(toy)).toBeNull(); // still in hand
      if (pose) expect(trainerFlip(thrower, { x: 0 }, toy)).toBe(toy.dir < 0);
      if (toyPosition(toy)) flying = true;
    }
    expect(poses).toEqual([null, "winds_up", "throws", null]);
    expect(flying).toBe(true);
    expect(THROW_WINDUP_S).toBeGreaterThan(0.2);
  });
});

describe("parallel searches", async () => {
  const { DOG_MOTION, SEARCH_MOTION, beginRetrieve, newActor, setActorGoal, stepActor } = await import("../public/js/model.js");
  const thrower = { x: 160, y: 160, moving: false, dir: 1 };
  const run = (p: any, secs: number) => {
    const delivered: string[] = [];
    let before = p.toys.map((t: any) => t.kind);
    for (let t = 0; t < secs; t += 0.05) {
      stepActor(p, 0.05, 90, { thrower, centerX: 38 * 16 }, () => 0.4);
      const now = p.toys.map((t: any) => t.kind);
      if (now.length < before.length) delivered.push(before[0]);
      before = now;
    }
    return delivered;
  };

  it("throws one toy per search running in parallel and brings them all back, one by one", () => {
    const p: any = newActor([176, 160]);
    setActorGoal(p, [160, 160], SEARCH_MOTION);
    p.wantToys = 2;
    run(p, 8);
    expect(p.toys).toHaveLength(2);
    expect(p.toys[0].kind).not.toBe(p.toys[1].kind); // different toys
    const kinds = p.toys.map((t: any) => t.kind);
    expect(beginRetrieve(p, DOG_MOTION.idle)).toBe(true);
    expect(run(p, 15)).toEqual(kinds);
    expect(p.commit).toBe(false);
  });
});

describe("no naps on duty", async () => {
  const { displayDogState } = await import("../public/js/model.js");
  it("a long command inside a turn does not put the dog to sleep; waiting for the person does", () => {
    const t0 = 1_000_000;
    const running = { state: "runs", since: t0, lastEventAt: t0, detail: null };
    expect(displayDogState(running, t0 + 5 * 60_000, false, true)).toBe("runs");
    expect(displayDogState(running, t0 + 5 * 60_000, false, false)).toBe("sleeps");
  });
});
