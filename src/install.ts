import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { copilotHooksFile, forwarderPath, hookCommand, INSTALL_EVENTS, PLATFORM_EVENTS, PLATFORM_NAMES } from "./hooks-config.js";
import type { Platform } from "./mapping/table.js";

/**
 * Hook installer. Rules:
 * - Merges with the existing settings: never touches foreign hooks or settings.
 * - Backup before every write; atomic write.
 * - Idempotent: reinstalling with no changes writes nothing.
 * - If the existing JSON is invalid, it aborts without writing.
 * - Uninstalling removes only the zoomies handlers (the ones that run
 *   zoomies-hook.cjs) and cleans up entries left empty.
 */

const MARKER = "zoomies-hook.cjs";

type Json = Record<string, unknown>;
interface Handler {
  type?: unknown;
  command?: unknown;
  [k: string]: unknown;
}
interface Entry {
  matcher?: unknown;
  hooks?: Handler[];
  [k: string]: unknown;
}

export function isZoomiesHandler(h: unknown): boolean {
  return typeof h === "object" && h !== null && typeof (h as Handler).command === "string" && ((h as Handler).command as string).includes(MARKER);
}

export class InstallError extends Error {}

function hooksObject(settings: Json): Record<string, Entry[]> {
  const hooks = settings.hooks;
  if (hooks === undefined) return {};
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) throw new InstallError('"hooks" is not an object: leaving it alone');
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) throw new InstallError(`"hooks.${event}" is not a list: leaving it alone`);
  }
  return hooks as Record<string, Entry[]>;
}

export interface MergeResult {
  settings: Json;
  added: string[];
  updated: string[];
}

/** Adds (or updates the path of) the zoomies handler on every event. Does not modify `settings`. */
export function mergeHooks(settings: Json, command: string, events: readonly string[] = INSTALL_EVENTS): MergeResult {
  const next = structuredClone(settings);
  const hooks = hooksObject(next);
  const added: string[] = [];
  const updated: string[] = [];
  for (const event of events) {
    const list = (hooks[event] ??= []);
    const ours = list.flatMap((e) => (Array.isArray(e.hooks) ? e.hooks.filter(isZoomiesHandler) : []));
    if (ours.length === 0) {
      list.push({ hooks: [{ type: "command", command, timeout: 2 }] });
      added.push(event);
    } else if (ours.some((h) => h.command !== command)) {
      for (const h of ours) h.command = command; // the zoomies checkout has moved
      updated.push(event);
    }
  }
  if (added.length || updated.length) next.hooks = hooks;
  return { settings: next, added, updated };
}

export interface RemoveResult {
  settings: Json;
  removed: string[];
}

/** Removes the zoomies handlers and cleans up empty entries, events and "hooks". */
export function removeHooks(settings: Json): RemoveResult {
  const next = structuredClone(settings);
  if (next.hooks === undefined) return { settings: next, removed: [] };
  const hooks = hooksObject(next);
  const removed: string[] = [];
  for (const [event, list] of Object.entries(hooks)) {
    let touched = false;
    const kept: Entry[] = [];
    for (const entry of list) {
      if (!Array.isArray(entry.hooks) || !entry.hooks.some(isZoomiesHandler)) {
        kept.push(entry);
        continue;
      }
      touched = true;
      const rest = entry.hooks.filter((h) => !isZoomiesHandler(h));
      if (rest.length) kept.push({ ...entry, hooks: rest });
    }
    if (!touched) continue;
    removed.push(event);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return { settings: next, removed };
}

export type Level = "project" | "user";

/**
 * Where each host reads its hooks from:
 * - Claude Code: `.claude/settings.local.json` (personal, not shared) or `~/.claude/settings.json`.
 * - Codex: `.codex/hooks.json` or `~/.codex/hooks.json` (`$CODEX_HOME`).
 * - Copilot CLI: our own file, `.github/hooks/zoomies.json` or `~/.copilot/hooks/zoomies.json`.
 */
export function settingsPath(level: Level, projectDir: string, platform: Platform = "claude"): string {
  const project = resolve(projectDir);
  if (platform === "codex") {
    const home = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
    return level === "user" ? join(home, "hooks.json") : join(project, ".codex", "hooks.json");
  }
  if (platform === "copilot") {
    return level === "user" ? join(homedir(), ".copilot", "hooks", "zoomies.json") : join(project, ".github", "hooks", "zoomies.json");
  }
  if (level === "user") {
    const base = process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
    return join(base, "settings.json");
  }
  return join(project, ".claude", "settings.local.json");
}

export function readSettings(file: string): Json {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new InstallError(`${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Nothing written: fix it or move it and try again.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new InstallError(`${file} does not contain a JSON object. Nothing written.`);
  return parsed as Json;
}

/** Backup (if the file exists) and atomic write. Returns the backup path. */
export function writeSettings(file: string, settings: Json, now = new Date()): string | null {
  mkdirSync(dirname(file), { recursive: true });
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = `${file}.zoomies-backup-${now.toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(file, backup);
  }
  const tmp = `${file}.zoomies-tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, file);
  return backup;
}

export interface RunOptions {
  level: Level;
  projectDir: string;
  /** Host to install for (Claude Code by default). */
  platform?: Platform;
  dryRun?: boolean;
  /** Forwarder path (tests); defaults to this checkout's. */
  forwarder?: string;
  log?: (line: string) => void;
}

type RunResult = { file: string; changed: boolean; backup: string | null };

/** Project-level Codex and Copilot hook files live inside the repository: say so. */
function repoFileNote(opts: RunOptions, file: string, log: (line: string) => void): void {
  if (opts.level !== "project" || !opts.platform || opts.platform === "claude") return;
  log(
    `Note: ${file} is inside the project. Add it to .gitignore unless your team wants it; ` +
      `the hooks do nothing (and never block ${PLATFORM_NAMES[opts.platform]}) on machines without this zoomies checkout.`,
  );
}

function installCopilot(opts: RunOptions, file: string, log: (line: string) => void): RunResult {
  const next = JSON.stringify(copilotHooksFile(opts.forwarder ?? forwarderPath()), null, 2) + "\n";
  if (existsSync(file) && readFileSync(file, "utf8") === next) {
    log(`Nothing to do: the zoomies hooks are already in ${file}`);
    return { file, changed: false, backup: null };
  }
  log(`Hooks (${PLATFORM_EVENTS.copilot.length}): ${PLATFORM_EVENTS.copilot.join(", ")}`);
  if (opts.dryRun) {
    log(`--dry-run: ${file} was not written`);
    return { file, changed: true, backup: null };
  }
  const backup = writeSettings(file, JSON.parse(next) as Json);
  log(`Wrote ${file}${backup ? ` (backup: ${backup})` : ""}`);
  repoFileNote(opts, file, log);
  return { file, changed: true, backup };
}

export function runInstall(opts: RunOptions): RunResult {
  const log = opts.log ?? console.log;
  const platform = opts.platform ?? "claude";
  const file = settingsPath(opts.level, opts.projectDir, platform);
  if (platform === "copilot") return installCopilot(opts, file, log);
  const command = hookCommand(opts.forwarder ?? forwarderPath(), platform);
  const { settings, added, updated } = mergeHooks(readSettings(file), command, PLATFORM_EVENTS[platform]);
  if (!added.length && !updated.length) {
    log(`Nothing to do: the zoomies hooks are already in ${file}`);
    return { file, changed: false, backup: null };
  }
  if (added.length) log(`Added (${added.length}): ${added.join(", ")}`);
  if (updated.length) log(`Path updated (${updated.length}): ${updated.join(", ")}`);
  if (opts.dryRun) {
    log(`--dry-run: ${file} was not written`);
    return { file, changed: true, backup: null };
  }
  const backup = writeSettings(file, settings);
  log(`Wrote ${file}${backup ? ` (backup: ${backup})` : ""}`);
  repoFileNote(opts, file, log);
  return { file, changed: true, backup };
}

export function runUninstall(opts: RunOptions): RunResult {
  const log = opts.log ?? console.log;
  const platform = opts.platform ?? "claude";
  const file = settingsPath(opts.level, opts.projectDir, platform);
  if (!existsSync(file)) {
    log(`${file} does not exist: nothing to uninstall`);
    return { file, changed: false, backup: null };
  }
  if (platform === "copilot") {
    // Our own file: remove it (only if it really is ours).
    if (!readFileSync(file, "utf8").includes("zoomies-hook.cjs")) {
      log(`${file} was not written by zoomies: leaving it alone`);
      return { file, changed: false, backup: null };
    }
    if (opts.dryRun) {
      log(`--dry-run: ${file} was not removed`);
      return { file, changed: true, backup: null };
    }
    rmSync(file);
    log(`Removed ${file}`);
    return { file, changed: true, backup: null };
  }
  const { settings, removed } = removeHooks(readSettings(file));
  if (!removed.length) {
    log(`No zoomies hooks in ${file}`);
    return { file, changed: false, backup: null };
  }
  log(`Removed from: ${removed.join(", ")}`);
  if (opts.dryRun) {
    log(`--dry-run: ${file} was not written`);
    return { file, changed: true, backup: null };
  }
  const backup = writeSettings(file, settings);
  log(`Wrote ${file} (backup: ${backup})`);
  return { file, changed: true, backup };
}
