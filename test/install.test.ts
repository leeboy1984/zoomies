import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INSTALL_EVENTS } from "../src/hooks-config.js";
import { InstallError, isZoomiesHandler, mergeHooks, removeHooks, runInstall, runUninstall, settingsPath } from "../src/install.js";

const CMD = 'node "/opt/zoomies/bin/zoomies-hook.cjs"';
const FORWARDER = "/opt/zoomies/bin/zoomies-hook.cjs";
const foreign = { type: "command", command: "/usr/local/bin/my-linter.sh" };

describe("hook merging (pure)", () => {
  it("adds one handler per event without touching other settings", () => {
    const before = { model: "x", permissions: { allow: ["Bash(npm test)"] } };
    const { settings, added } = mergeHooks(before, CMD);
    expect(added).toEqual([...INSTALL_EVENTS]);
    expect(settings.model).toBe("x");
    expect(settings.permissions).toEqual({ allow: ["Bash(npm test)"] });
    expect(before).not.toHaveProperty("hooks"); // does not mutate the input
  });

  it("keeps foreign hooks, also on the same event", () => {
    const before = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [foreign] }] } };
    const { settings } = mergeHooks(before, CMD);
    const pre = (settings.hooks as any).PreToolUse;
    expect(pre[0]).toEqual({ matcher: "Bash", hooks: [foreign] });
    expect(pre[1].hooks[0].command).toBe(CMD);
  });

  it("is idempotent and updates the path if zoomies has moved", () => {
    const once = mergeHooks({}, CMD).settings;
    expect(mergeHooks(once, CMD)).toMatchObject({ added: [], updated: [] });
    const moved = mergeHooks(once, 'node "/nuevo/zoomies/bin/zoomies-hook.cjs"');
    expect(moved.added).toEqual([]);
    expect(moved.updated).toHaveLength(INSTALL_EVENTS.length);
  });

  it("uninstalling removes only zoomies' handlers and cleans up empties", () => {
    const installed = mergeHooks({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [foreign] }] } }, CMD).settings;
    // Also, someone put our handler next to a foreign one in the same entry.
    (installed.hooks as any).Stop.push({ hooks: [foreign, { type: "command", command: CMD }] });
    const { settings, removed } = removeHooks(installed);
    expect([...removed].sort()).toEqual([...INSTALL_EVENTS].sort());
    expect(settings.hooks).toEqual({
      PreToolUse: [{ matcher: "Bash", hooks: [foreign] }],
      Stop: [{ hooks: [foreign] }],
    });
    expect(removeHooks(mergeHooks({}, CMD).settings).settings).toEqual({});
  });

  it("leaves odd structures alone", () => {
    expect(() => mergeHooks({ hooks: [] }, CMD)).toThrow(InstallError);
    expect(() => mergeHooks({ hooks: { Stop: {} } }, CMD)).toThrow(InstallError);
    expect(isZoomiesHandler({ command: "echo hola" })).toBe(false);
  });
});

describe("install-hooks / uninstall-hooks on disk", () => {
  let dir: string;
  const log: string[] = [];
  const opts = () => ({ level: "project" as const, projectDir: dir, forwarder: FORWARDER, log: (l: string) => log.push(l) });
  const file = () => settingsPath("project", dir);
  const backups = () => readdirSync(join(dir, ".claude")).filter((f) => f.includes("zoomies-backup"));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zoomies-install-"));
    log.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the project's .claude/settings.local.json by default", () => {
    expect(file()).toBe(join(dir, ".claude", "settings.local.json"));
    const r = runInstall(opts());
    expect(r).toMatchObject({ changed: true, backup: null });
    const written = JSON.parse(readFileSync(file(), "utf8"));
    expect(Object.keys(written.hooks)).toEqual([...INSTALL_EVENTS]);
  });

  it("backs up before writing and does not rewrite without changes", () => {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(file(), JSON.stringify({ hooks: { Stop: [{ hooks: [foreign] }] }, model: "y" }));
    runInstall(opts());
    expect(backups()).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, ".claude", backups()[0]!), "utf8")).model).toBe("y");
    expect(runInstall(opts()).changed).toBe(false);
    expect(backups()).toHaveLength(1);
  });

  it("aborts without writing if the existing JSON is invalid", () => {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(file(), "{ this is not json");
    expect(() => runInstall(opts())).toThrow(/is not valid JSON/);
    expect(readFileSync(file(), "utf8")).toBe("{ this is not json");
    expect(backups()).toHaveLength(0);
  });

  it("--dry-run writes nothing", () => {
    expect(runInstall({ ...opts(), dryRun: true }).changed).toBe(true);
    expect(existsSync(file())).toBe(false);
  });

  it("uninstalling leaves foreign hooks as they were", () => {
    mkdirSync(join(dir, ".claude"));
    const original = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [foreign] }] }, env: { A: "1" } };
    writeFileSync(file(), JSON.stringify(original));
    runInstall(opts());
    runUninstall(opts());
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual(original);
    expect(runUninstall(opts()).changed).toBe(false);
  });

  it("--user uses ~/.claude/settings.json (or CLAUDE_CONFIG_DIR)", () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      expect(settingsPath("user", "/anywhere")).toBe(join(dir, "settings.json"));
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

describe("other hosts: Codex and GitHub Copilot CLI", () => {
  let dir: string;
  const log: string[] = [];
  const opts = (platform: "codex" | "copilot") => ({ level: "project" as const, projectDir: dir, platform, forwarder: FORWARDER, log: (l: string) => log.push(l) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zoomies-install-"));
    log.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("Codex: merges into .codex/hooks.json with --source codex, keeping foreign hooks", () => {
    const file = settingsPath("project", dir, "codex");
    expect(file).toBe(join(dir, ".codex", "hooks.json"));
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [foreign] }] } }));
    runInstall(opts("codex"));
    const hooks = JSON.parse(readFileSync(file, "utf8")).hooks;
    expect(hooks.PreToolUse[0].hooks[0].command).toBe(`${CMD} --source codex`);
    expect(hooks.Interrupt).toBeDefined();
    expect(hooks.Stop[0].hooks[0]).toEqual(foreign);
    runUninstall(opts("codex"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ hooks: { Stop: [{ hooks: [foreign] }] } });
    expect(log.some((l) => l.includes("inside the project"))).toBe(true);
  });

  it("Copilot: its own .github/hooks/zoomies.json, with commands that can never block a tool", () => {
    const file = settingsPath("project", dir, "copilot");
    expect(file).toBe(join(dir, ".github", "hooks", "zoomies.json"));
    expect(runInstall(opts("copilot")).changed).toBe(true);
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    expect(cfg.version).toBe(1);
    const pre = cfg.hooks.PreToolUse[0];
    expect(pre.bash).toBe(`${CMD} --source copilot || true`);
    expect(pre.powershell).toBe(`${CMD} --source copilot; exit 0`);
    expect(runInstall(opts("copilot")).changed).toBe(false); // idempotent
    expect(runUninstall(opts("copilot")).changed).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("Copilot: never removes a zoomies.json it did not write", () => {
    const file = settingsPath("project", dir, "copilot");
    mkdirSync(join(dir, ".github", "hooks"), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, hooks: {} }));
    expect(runUninstall(opts("copilot")).changed).toBe(false);
    expect(existsSync(file)).toBe(true);
  });
});
