import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CONFIG, configuredCompanion, configuredScenario, loadConfig, parseConfig, parseDog, saveDog, withDog } from "../src/config.js";
import { sanitize } from "../src/mapping/sanitize.js";
import { SessionStore, companionLookFor } from "../src/state/store.js";
import * as f from "./fixtures/payloads.js";
import { BREED_COATS } from "../src/mapping/table.js";

describe("zoomies.config.json", () => {
  it("without a file: defaults (one dog per project, agility for tasks)", () => {
    expect(loadConfig(join(tmpdir(), "no-existe.json"))).toEqual({ config: DEFAULT_CONFIG, file: null });
    expect(DEFAULT_CONFIG.companion).toBeNull();
    expect(DEFAULT_CONFIG.companions).toEqual([]);
  });

  it("assigns a scene per folder, the most specific wins, and understands ~", () => {
    const c = parseConfig({ scenarios: { "/p": "park", "/p/blog": "forest", "~/tasks": "agility", "/sea": "beach" } });
    expect(configuredScenario(c, "/sea/waves")).toBe("beach");
    expect(configuredScenario(c, "/p/api")).toBe("park");
    expect(configuredScenario(c, "/p/blog/posts")).toBe("forest");
    expect(configuredScenario(c, "/p/blog")).toBe("forest");
    expect(configuredScenario(c, "/pepe")).toBeNull();
    expect(configuredScenario(c, join(homedir(), "tasks", "x"))).toBe("agility");
  });

  it("rejects invalid configs with a clear message", () => {
    expect(() => parseConfig({ scenarios: { "/p": "luna" } })).toThrow(/unknown scene "luna"/);
    expect(() => parseConfig({ companion: { breed: "caniche" } })).toThrow(/unknown breed "caniche"/);
    expect(() => parseConfig({ companion: { breed: "dachshund", coat: "azul" } })).toThrow(/unknown coat "azul"/);
    expect(() => parseConfig({ agilityForTasks: "yes" })).toThrow(ConfigError);
    expect(() => parseConfig({ scenes: {} })).toThrow(/unknown key/);
    const dir = mkdtempSync(join(tmpdir(), "zoomies-cfg-"));
    writeFileSync(join(dir, "c.json"), "{ roto");
    expect(() => loadConfig(join(dir, "c.json"))).toThrow(/invalid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the companion comes from the config (without a coat, or \"random\": one per project)", () => {
    expect(parseConfig({ companion: { breed: "pug", coat: "black" } }).companion).toEqual({ breed: "pug", coat: "black" });
    expect(parseConfig({ companion: { breed: "pug" } }).companion).toEqual({ breed: "pug", coat: null });
    expect(parseConfig({ companion: { breed: "pug", coat: "random" } }).companion).toEqual({ breed: "pug", coat: null });
    expect(parseConfig({ companion: "beagle" }).companion).toEqual({ breed: "beagle", coat: null });
  });

  it("assigns a dog per folder, the most specific wins over the global one", () => {
    const c = parseConfig({
      companion: { breed: "mutt", coat: "grey" },
      companions: { "/p": "pug", "/p/blog": { breed: "border_collie", coat: "merle" } },
    });
    expect(configuredCompanion(c, "/p/blog/posts")).toEqual({ breed: "border_collie", coat: "merle" });
    expect(configuredCompanion(c, "/p/api")).toEqual({ breed: "pug", coat: null });
    expect(configuredCompanion(c, "/other")).toEqual({ breed: "mutt", coat: "grey" });
    expect(configuredCompanion(parseConfig({}), "/p")).toBeNull();
    expect(() => parseConfig({ companions: { "/p": "poodle" } })).toThrow(/unknown breed "poodle" in "companions" for \/p/);
    expect(() => parseConfig({ companions: ["pug"] })).toThrow(/folder → dog/);
  });
});

describe("each session's scene", () => {
  const apply = (store: SessionStore, payloads: Record<string, unknown>[]) => {
    let t = 1000;
    for (const p of payloads) store.apply(sanitize(p)!, (t += 10));
    return store.view(f.SESSION)!;
  };

  it("uses the scene configured for its cwd", () => {
    const store = new SessionStore({}, parseConfig({ scenarios: { [f.CWD]: "forest" } }));
    expect(apply(store, [f.sessionStart()]).scenario).toBe("forest");
  });

  it("moves to agility on its first completed task if not configured", () => {
    const store = new SessionStore();
    const before = apply(store, [f.sessionStart()]).scenario;
    expect(["park", "forest", "beach", "square", "snow"]).toContain(before);
    expect(apply(store, [f.taskCompleted("1")]).scenario).toBe("agility");
  });

  it("does not move to agility if the scene is configured or the option is off", () => {
    const configured = new SessionStore({}, parseConfig({ scenarios: { [f.CWD]: "park" } }));
    expect(apply(configured, [f.sessionStart(), f.taskCompleted("1")]).scenario).toBe("park");
    const off = new SessionStore({}, parseConfig({ agilityForTasks: false }));
    expect(apply(off, [f.sessionStart(), f.taskCompleted("1")]).scenario).not.toBe("agility");
  });

  it("the configured companion reaches the view", () => {
    const store = new SessionStore({}, parseConfig({ companion: { breed: "border_collie", coat: "merle" } }));
    expect(apply(store, [f.sessionStart()]).companionLook).toEqual({ breed: "border_collie", coat: "merle" });
  });

  it("with only a breed, each project gets a coat of that breed", () => {
    const store = new SessionStore({}, parseConfig({ companion: "dachshund" }));
    expect(apply(store, [f.sessionStart()]).companionLook).toEqual(companionLookFor(f.CWD, "dachshund"));
    const coats = new Set(Array.from({ length: 60 }, (_, i) => companionLookFor(`/projects/p${i}`, "dachshund")));
    expect([...coats].every((l) => l.breed === "dachshund")).toBe(true);
    expect(new Set([...coats].map((l) => l.coat)).size).toBe(BREED_COATS.dachshund.length);
  });

  it("without a configured dog, each project gets its own, always the same", () => {
    const look = apply(new SessionStore(), [f.sessionStart()]).companionLook;
    expect(look).toEqual(companionLookFor(f.CWD));
    expect(apply(new SessionStore(), [f.sessionStart()]).companionLook).toEqual(look);
    const breeds = new Set(Array.from({ length: 60 }, (_, i) => companionLookFor(`/projects/p${i}`).breed));
    expect(breeds.size).toBe(5);
  });
});

describe("choosing the dog at install time", () => {
  it("parses --dog: random, a breed or breed:coat", () => {
    expect(parseDog("random")).toBeNull();
    expect(parseDog("pug")).toEqual({ breed: "pug", coat: null });
    expect(parseDog("pug:random")).toEqual({ breed: "pug", coat: null });
    expect(parseDog("border_collie:merle")).toEqual({ breed: "border_collie", coat: "merle" });
    expect(() => parseDog("poodle")).toThrow(ConfigError);
    expect(() => parseDog("pug:blue")).toThrow(/unknown coat "blue"/);
  });

  it("writes the dog for a folder (with ~) or for every session, keeping the rest", () => {
    const raw = { scenarios: { "/p": "park" }, companions: { [join(homedir(), "blog")]: "beagle" } };
    const perDir = withDog(raw, join(homedir(), "blog"), { breed: "pug", coat: "black" });
    expect(perDir).toEqual({ scenarios: { "/p": "park" }, companions: { "~/blog": { breed: "pug", coat: "black" } } });
    expect(withDog(perDir, join(homedir(), "blog"), null)).toEqual({ scenarios: { "/p": "park" } });
    expect(withDog({}, null, { breed: "dachshund", coat: null })).toEqual({ companion: { breed: "dachshund" } });
    const all = withDog({}, null, { breed: "mutt", coat: "grey" });
    expect(all).toEqual({ companion: { breed: "mutt", coat: "grey" } });
    expect(withDog(all, null, null)).toEqual({});
  });

  it("saves it atomically, reports changes and refuses a broken file", () => {
    const dir = mkdtempSync(join(tmpdir(), "zoomies-dog-"));
    const file = join(dir, "zoomies.config.json");
    expect(saveDog(file, "/p", { breed: "pug", coat: "fawn" }, true)).toBe(true);
    expect(() => readFileSync(file)).toThrow();
    expect(saveDog(file, "/p", { breed: "pug", coat: "fawn" })).toBe(true);
    expect(saveDog(file, "/p", { breed: "pug", coat: "fawn" })).toBe(false);
    expect(configuredCompanion(loadConfig(file).config, "/p/x")).toEqual({ breed: "pug", coat: "fawn" });
    writeFileSync(file, "{ roto");
    expect(() => saveDog(file, "/p", null)).toThrow(/invalid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });
});
