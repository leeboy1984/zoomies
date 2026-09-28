import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { BREED_COATS, BREEDS, SCENARIOS, type Breed, type Scenario } from "./mapping/table.js";

/**
 * zoomies.config.json (optional). Example in zoomies.config.example.json.
 *
 * {
 *   "scenarios": { "~/projects/blog": "forest", "/srv/api": "park" },
 *   "agilityForTasks": true,
 *   "companion": { "breed": "dachshund", "coat": "red" },
 *   "companions": { "~/projects/blog": { "breed": "pug" } }
 * }
 *
 * - scenarios: folder → scene. A session whose cwd is inside the folder uses
 *   that scene; the most specific folder wins. Without a match, the scene is
 *   picked by hashing the cwd (park, forest, beach, square or snow).
 * - agilityForTasks: when a session without a configured scene completes its
 *   first task, it moves to agility (one obstacle per task). Defaults to true.
 * - companion: breed and coat of every session's dog. Without it, each project
 *   gets its own dog, picked by hashing the cwd (same project, same dog).
 *   Without a coat (or "random"), each project gets a coat of that breed.
 * - companions: folder → dog, like scenarios; it wins over companion.
 */
export interface ZoomiesConfig {
  scenarios: { dir: string; scenario: Scenario }[];
  agilityForTasks: boolean;
  /** Dog for every session; null = one per project, from a hash of the cwd. */
  companion: CompanionLook | null;
  companions: { dir: string; look: CompanionLook }[];
}

export interface CompanionLook {
  breed: Breed;
  /** null = a coat of the breed per project, from a hash of the cwd. */
  coat: string | null;
}

export const DEFAULT_CONFIG: ZoomiesConfig = {
  scenarios: [],
  agilityForTasks: true,
  companion: null,
  companions: [],
};

export class ConfigError extends Error {}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

/** Normalises a folder for prefix comparison (no trailing slash). */
function normDir(p: string): string {
  const abs = resolve(expandHome(p));
  return abs.length > 1 && abs.endsWith(sep) ? abs.slice(0, -1) : abs;
}

/** A dog is { "breed": …, "coat": … } or just the breed (no coat or "random": one per project). */
function parseLook(value: unknown, where: string, fail: (msg: string) => never): CompanionLook {
  const c = (typeof value === "string" ? { breed: value } : value) as Record<string, unknown> | null;
  if (c === null || typeof c !== "object" || Array.isArray(c)) fail(`${where} must be { "breed": …, "coat": … }`);
  const look = c as Record<string, unknown>;
  const at = where ? ` in ${where}` : "";
  if (!BREEDS.includes(look.breed as Breed)) fail(`unknown breed "${String(look.breed)}"${at} (use: ${BREEDS.join(", ")})`);
  const breed = look.breed as Breed;
  const coat = look.coat === undefined || look.coat === "random" ? null : look.coat;
  if (coat !== null && !BREED_COATS[breed].includes(coat as string)) fail(`unknown coat "${String(coat)}" for ${breed}${at} (use: ${BREED_COATS[breed].join(", ")})`);
  return { breed, coat: coat as string | null };
}

export function parseConfig(raw: unknown, source = "zoomies.config.json"): ZoomiesConfig {
  const fail = (msg: string): never => {
    throw new ConfigError(`${source}: ${msg}`);
  };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("must be a JSON object");
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!["scenarios", "agilityForTasks", "companion", "companions", "$comment"].includes(key)) fail(`unknown key "${key}"`);
  }

  const scenarios: ZoomiesConfig["scenarios"] = [];
  if (obj.scenarios !== undefined) {
    if (obj.scenarios === null || typeof obj.scenarios !== "object" || Array.isArray(obj.scenarios)) {
      fail('"scenarios" must be an object folder → scene');
    }
    for (const [dir, scenario] of Object.entries(obj.scenarios as Record<string, unknown>)) {
      if (!dir.trim()) fail('"scenarios" has an empty folder');
      if (!SCENARIOS.includes(scenario as Scenario)) fail(`unknown scene "${String(scenario)}" for ${dir} (use: ${SCENARIOS.join(", ")})`);
      scenarios.push({ dir: normDir(dir), scenario: scenario as Scenario });
    }
  }
  // Most specific folder first.
  scenarios.sort((a, b) => b.dir.length - a.dir.length);

  let agilityForTasks = DEFAULT_CONFIG.agilityForTasks;
  if (obj.agilityForTasks !== undefined) {
    if (typeof obj.agilityForTasks !== "boolean") fail('"agilityForTasks" must be true or false');
    agilityForTasks = obj.agilityForTasks as boolean;
  }

  const companion = obj.companion === undefined ? null : parseLook(obj.companion, '"companion"', fail);

  const companions: ZoomiesConfig["companions"] = [];
  if (obj.companions !== undefined) {
    if (obj.companions === null || typeof obj.companions !== "object" || Array.isArray(obj.companions)) {
      fail('"companions" must be an object folder → dog');
    }
    for (const [dir, look] of Object.entries(obj.companions as Record<string, unknown>)) {
      if (!dir.trim()) fail('"companions" has an empty folder');
      companions.push({ dir: normDir(dir), look: parseLook(look, `"companions" for ${dir}`, fail) });
    }
  }
  companions.sort((a, b) => b.dir.length - a.dir.length);

  return { scenarios, agilityForTasks, companion, companions };
}

export function loadConfig(file: string | undefined): { config: ZoomiesConfig; file: string | null } {
  if (!file || !existsSync(file)) return { config: DEFAULT_CONFIG, file: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`${file}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return { config: parseConfig(raw, file), file };
}

/** The most specific entry whose folder contains cwd (entries sorted longest first). */
function matchDir<T extends { dir: string }>(entries: T[], cwd: string): T | null {
  const dir = normDir(cwd);
  return entries.find((e) => dir === e.dir || dir.startsWith(e.dir + sep)) ?? null;
}

/** Configured scene for a cwd, or null if no folder contains it. */
export function configuredScenario(config: ZoomiesConfig, cwd: string): Scenario | null {
  return matchDir(config.scenarios, cwd)?.scenario ?? null;
}

/** Configured dog for a cwd (folder first, then the global one), or null. */
export function configuredCompanion(config: ZoomiesConfig, cwd: string | null): CompanionLook | null {
  const byDir = cwd ? matchDir(config.companions, cwd) : null;
  return byDir ? { ...byDir.look } : config.companion ? { ...config.companion } : null;
}

/** `--dog random|<breed>[:<coat>]`: null = one per project (random); no coat = any of the breed. */
export function parseDog(value: string): CompanionLook | null {
  if (value === "random") return null;
  const [breed, coat] = value.split(":");
  return parseLook({ breed, coat }, "", (msg) => {
    throw new ConfigError(`--dog: ${msg}`);
  });
}

/** A dog as written in the config: without a coat when any coat of the breed will do. */
function lookJson(look: CompanionLook): Record<string, string> {
  return look.coat ? { breed: look.breed, coat: look.coat } : { breed: look.breed };
}

/** Shows a folder with ~ for the home directory, as people write it in the config. */
function tildeDir(dir: string): string {
  const abs = normDir(dir);
  const home = homedir();
  return abs === home || abs.startsWith(home + sep) ? "~" + abs.slice(home.length) : abs;
}

/**
 * The raw config with a dog chosen at install time: for a folder (`companions`)
 * or, with dir = null, for every session (`companion`). look = null goes back to
 * one dog per project, so it removes that setting. Other keys are kept.
 */
export function withDog(raw: Record<string, unknown>, dir: string | null, look: CompanionLook | null): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };
  if (dir === null) {
    if (look) next.companion = lookJson(look);
    else delete next.companion;
    return next;
  }
  const key = tildeDir(dir);
  const companions = { ...((raw.companions as Record<string, unknown> | undefined) ?? {}) };
  // The same folder may already be there written another way (absolute or with ~).
  for (const existing of Object.keys(companions)) if (normDir(existing) === normDir(dir)) delete companions[existing];
  if (look) companions[key] = lookJson(look);
  if (Object.keys(companions).length) next.companions = companions;
  else delete next.companions;
  return next;
}

/** Saves the dog into the config file (validated, atomic). Returns whether it changed. */
export function saveDog(file: string, dir: string | null, look: CompanionLook | null, dryRun = false): boolean {
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new ConfigError(`${file}: invalid JSON (${err instanceof Error ? err.message : String(err)}); fix it or choose the dog by hand`);
    }
    parseConfig(raw, file);
  }
  const next = withDog(raw, dir, look);
  parseConfig(next, file);
  if (JSON.stringify(next) === JSON.stringify(raw)) return false;
  if (!dryRun) {
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, file);
  }
  return true;
}
