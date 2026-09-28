import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { artMain } from "./art/cli.js";
import { spawn } from "node:child_process";
import { DaemonError, formatUptime, logFile, readInfo, start, status, stop, tailLog } from "./daemon.js";
import { ConfigError, loadConfig, parseDog, saveDog, type CompanionLook } from "./config.js";
import { InstallError, runInstall, runUninstall, settingsPath, type Level } from "./install.js";
import { createInterface } from "node:readline/promises";
import { copilotHooksFile, hookCommand, hooksSnippet, PLATFORM_EVENTS, PLATFORM_NAMES } from "./hooks-config.js";
import { BREED_COATS, BREEDS, PLATFORMS, type Breed, type Platform } from "./mapping/table.js";
import { readRecording, summarize } from "./inspect.js";
import { Recorder } from "./recorder.js";
import { readReplayFile, replay } from "./replay.js";
import { DEFAULT_PORT, startServer } from "./server.js";

const RECORDINGS_DIR = fileURLToPath(new URL("../recordings/", import.meta.url));
/** Pid and log of the background server (`zoomies start`). */
const RUN_DIR = fileURLToPath(new URL("../run/", import.meta.url));
const ENTRY = fileURLToPath(new URL("../bin/zoomies.mjs", import.meta.url));

const USAGE = `zoomies (Dog Park)

Usage:
  zoomies start [--port N] [--record] [--config f.json] [--open]
                                        Starts the server in the background (port ${DEFAULT_PORT})
  zoomies stop | restart | status       Stops, restarts or shows the background server
  zoomies open                          Opens the park in the browser
  zoomies logs [-n N]                   Last N lines of the background server's log (40)
  zoomies serve [--port N] [--record] [--config f.json]
                                        Starts the server in this terminal (Ctrl+C stops it)
  zoomies install-hooks [--platform P] [--dog D] [--project DIR] [--user [--yes]] [--dry-run]
                                        Installs the hooks for Claude Code, Codex and/or GitHub
                                        Copilot CLI (P = claude, codex, copilot, all or a
                                        comma-separated list) and picks the dog (D = random,
                                        a breed or breed:coat); asks for both when omitted
  zoomies uninstall-hooks [--platform P] [--project DIR] [--user [--yes]] [--dry-run]
                                        Removes only the hooks zoomies installed
  zoomies hooks-snippet [--platform P]  Prints the hooks configuration to paste by hand
  zoomies inspect <file.jsonl>          Summarises a recording without showing sensitive values
  zoomies replay <file.jsonl> [--speed N] [--max-gap S] [--keep-ids] [--port N]
                                        Replays a recording against the server
                                        (--speed 2 = twice as fast; --max-gap
                                        trims long waits to S seconds)
  zoomies art <build|check|normalize|preview>
                                        Art pipeline (see STYLE.md)
`;

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function parsePort(args: string[]): number {
  const raw = flagValue(args, "--port");
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new Error("--port needs a number between 1 and 65535");
  return port;
}

function parsePositive(args: string[], flag: string, fallback: number): number {
  const raw = flagValue(args, flag);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!(n > 0)) throw new Error(`${flag} needs a number greater than 0`);
  return n;
}

const RECORD_WARNING = `
  ┌──────────────────────────────────────────────────────────────────────┐
  │ RECORD MODE ON                                                       │
  │ The RAW hook payloads are stored: paths, commands, prompts,          │
  │ contents of written files and tool responses.                        │
  │ Use it only with personal projects.                                  │
  │ Directory (git-ignored): recordings/                                 │
  └──────────────────────────────────────────────────────────────────────┘
`;

/** --config, or zoomies.config.json in the current folder, or the one in the zoomies folder. */
function configPathFor(args: string[]): string {
  const repoConfig = fileURLToPath(new URL("../zoomies.config.json", import.meta.url));
  return flagValue(args, "--config") ?? (existsSync("zoomies.config.json") ? join(process.cwd(), "zoomies.config.json") : repoConfig);
}

async function serve(args: string[]): Promise<void> {
  const port = parsePort(args);
  const recorder = args.includes("--record") ? new Recorder(RECORDINGS_DIR) : undefined;
  if (recorder) console.log(RECORD_WARNING + `  Recording to: ${recorder.file}\n`);

  const configPath = configPathFor(args);
  const { config, file } = loadConfig(configPath);
  if (flagValue(args, "--config") && !file) throw new Error(`${configPath} does not exist`);
  console.log(file ? `Config: ${file}` : "No zoomies.config.json: scene and dog picked per project.");

  const srv = await startServer({ port, recorder, config });
  console.log(`zoomies listening on http://127.0.0.1:${srv.port}`);

  const shutdown = async () => {
    await srv.close();
    await recorder?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Arguments `start` passes on to `serve`, with the config resolved from here. */
function serveArgsFor(args: string[]): string[] {
  const out: string[] = [];
  if (args.includes("--record")) out.push("--record");
  const config = resolve(configPathFor(args));
  if (flagValue(args, "--config") && !existsSync(config)) throw new Error(`${config} does not exist`);
  if (existsSync(config)) out.push("--config", config);
  return out;
}

function openBrowser(url: string): void {
  const [cmd, cmdArgs] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" });
  child.on("error", () => console.log(`Open ${url} in your browser.`));
  child.unref();
}

/** Port of the background server: --port, the one it was started on, or the default. */
function daemonPort(args: string[]): number {
  return flagValue(args, "--port") ? parsePort(args) : readInfo(RUN_DIR)?.port ?? DEFAULT_PORT;
}

async function daemonCommand(command: string, args: string[]): Promise<void> {
  const opts = { dir: RUN_DIR, entry: ENTRY, log: (line: string) => console.log(line) };
  const port = daemonPort(args);
  try {
    switch (command) {
      case "start":
      case "restart": {
        const serveArgs = serveArgsFor(args);
        if (command === "restart") await stop(opts, port);
        await start(opts, port, serveArgs);
        if (args.includes("--open")) openBrowser(`http://127.0.0.1:${port}/`);
        return;
      }
      case "stop":
        await stop(opts, port);
        return;
      case "status": {
        const s = await status(RUN_DIR, port);
        if (s.state === "running") {
          console.log(`zoomies is running on http://127.0.0.1:${s.info.port} (pid ${s.info.pid}, up ${formatUptime(Date.now() - s.info.startedAt)}).`);
          console.log(`Log: ${logFile(RUN_DIR)}`);
        } else if (s.state === "foreground") {
          console.log(`A zoomies server started with "serve" is running on http://127.0.0.1:${s.port}.`);
        } else {
          console.log('zoomies is not running. Start it with "zoomies start".');
          process.exitCode = 3;
        }
        return;
      }
      case "open": {
        const s = await status(RUN_DIR, port);
        if (s.state === "stopped") {
          console.log('zoomies is not running. Start it with "zoomies start --open".');
          process.exitCode = 1;
          return;
        }
        const url = `http://127.0.0.1:${s.state === "running" ? s.info.port : s.port}/`;
        console.log(url);
        openBrowser(url);
        return;
      }
      case "logs": {
        const n = parsePositive(args, "-n", 40);
        const text = tailLog(RUN_DIR, n);
        console.log(text || `No log yet (${logFile(RUN_DIR)}).`);
        return;
      }
    }
  } catch (err) {
    if (err instanceof DaemonError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

function inspect(args: string[]): void {
  const file = args[0];
  if (!file) throw new Error("Missing file: zoomies inspect recordings/<file>.jsonl");
  const { lines, invalid } = readRecording(file);
  console.log(JSON.stringify(summarize(lines, invalid), null, 2));
}

async function replayCommand(args: string[]): Promise<void> {
  const valueFlags = ["--speed", "--max-gap", "--port"];
  const file = args.find((a, i) => !a.startsWith("--") && !valueFlags.includes(args[i - 1] ?? ""));
  if (!file) throw new Error("Missing file: zoomies replay examples/demo.jsonl");
  const steps = readReplayFile(file);
  const speed = parsePositive(args, "--speed", 1);
  const maxGapS = parsePositive(args, "--max-gap", Infinity);
  const port = parsePort(args);
  console.log(`Replaying ${steps.length} events from ${file} at x${speed} against 127.0.0.1:${port}`);
  const { sent, accepted } = await replay(steps, {
    port,
    speed,
    maxGapMs: maxGapS * 1000,
    keepIds: args.includes("--keep-ids"),
    onEvent: (step, i, total) => {
      const name = String(step.payload.hook_event_name);
      const tool = typeof step.payload.tool_name === "string" ? ` ${step.payload.tool_name}` : "";
      process.stdout.write(`\r  ${i + 1}/${total} ${name}${tool}`.padEnd(60));
    },
  });
  console.log(`\nDone: ${accepted}/${sent} events accepted.`);
}

async function confirmUser(args: string[], action: string, platforms: Platform[]): Promise<boolean> {
  if (args.includes("--yes")) return true;
  const files = platforms.map((p) => settingsPath("user", ".", p)).join(", ");
  const names = platforms.map((p) => PLATFORM_NAMES[p]).join(", ");
  console.log(
    `\nWARNING: you are about to ${action} the zoomies hooks at USER level (${files}).\n` +
      `This affects ALL your ${names} sessions, in every project.\n`,
  );
  if (!process.stdin.isTTY) {
    console.error("No terminal to confirm. Run again with --yes if you are sure.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Type "yes" to continue: ')).trim().toLowerCase();
  rl.close();
  return answer === "yes" || answer === "y";
}

/** `--platform claude|codex|copilot|all` (or a comma-separated list). */
export function parsePlatforms(value: string): Platform[] {
  if (value === "all") return [...PLATFORMS];
  const list = value.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const unknown = list.filter((p) => !PLATFORMS.includes(p as Platform));
  if (!list.length || unknown.length) throw new Error(`--platform must be ${PLATFORMS.join(", ")} or all (got "${value}")`);
  return [...new Set(list)] as Platform[];
}

/** Which hosts to (un)install for: --platform, or ask in a terminal (Claude Code without one, as before). */
async function choosePlatforms(args: string[]): Promise<Platform[]> {
  const flag = flagValue(args, "--platform");
  if (flag) return parsePlatforms(flag);
  if (!process.stdin.isTTY) return ["claude"];
  console.log("\nWhich tool do you want to connect to zoomies?");
  PLATFORMS.forEach((p, i) => console.log(`  ${i + 1}) ${PLATFORM_NAMES[p]}`));
  console.log(`  ${PLATFORMS.length + 1}) All of them`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Choose (e.g. 1 or 1,2) [1]: ")).trim();
  rl.close();
  if (!answer) return ["claude"];
  const picked = answer.split(",").map((n) => Number(n.trim()));
  if (picked.includes(PLATFORMS.length + 1)) return [...PLATFORMS];
  const chosen = picked.map((n) => PLATFORMS[n - 1]).filter((p): p is Platform => Boolean(p));
  if (!chosen.length) throw new Error(`Unknown choice "${answer}"`);
  return [...new Set(chosen)];
}

/** Asks for a number from 1 to n; empty = 1. */
async function pick(question: string, options: string[]): Promise<number> {
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [1]: `)).trim();
  rl.close();
  const n = answer ? Number(answer) : 1;
  if (!Number.isInteger(n) || n < 1 || n > options.length) throw new Error(`Unknown choice "${answer}"`);
  return n;
}

/**
 * The dog for the sessions being hooked up: --dog, or ask in a terminal.
 * null = one per project (random); undefined = do not touch the config.
 */
async function chooseDog(args: string[], who: string): Promise<CompanionLook | null | undefined> {
  const flag = flagValue(args, "--dog");
  if (flag) return parseDog(flag);
  if (!process.stdin.isTTY) return undefined;
  console.log(`\nWhich dog should ${who} bring?`);
  const n = await pick("Choose", ["A different one per project, picked for you", ...BREEDS.map((b) => b.replace("_", " "))]);
  if (n === 1) return null;
  const breed = BREEDS[n - 2] as Breed;
  const coats = BREED_COATS[breed];
  console.log("\nWhich coat?");
  const c = await pick("Choose", ["Any, a different one per project", ...coats.map((coat) => coat.replace("_", " "))]);
  return { breed, coat: c === 1 ? null : coats[c - 2] ?? null };
}

const RESTART: Record<Platform, string> = {
  claude: "Restart Claude Code (or check /hooks) so it loads them.",
  codex: "Restart Codex so it loads them.",
  copilot: "Start a new Copilot CLI session so it loads them.",
};

async function hooksCommand(args: string[], install: boolean): Promise<void> {
  const level: Level = args.includes("--user") ? "user" : "project";
  const projectDir = flagValue(args, "--project") ?? process.cwd();
  const platforms = await choosePlatforms(args);
  if (level === "user" && !(await confirmUser(args, install ? "install" : "uninstall", platforms))) {
    console.log("Cancelled. Nothing was changed.");
    process.exitCode = 1;
    return;
  }
  const dryRun = args.includes("--dry-run");
  const who = level === "user" ? "all your sessions" : `the sessions in ${basename(resolve(projectDir))}`;
  try {
    // Ask everything first, so a bad answer changes nothing.
    const dog = install ? await chooseDog(args, who) : undefined;
    const dogFile = configPathFor(args);
    const dogDir = level === "user" ? null : resolve(projectDir);
    if (dog !== undefined) saveDog(dogFile, dogDir, dog, true); // fails early on a broken config
    for (const platform of platforms) {
      console.log(`\n${PLATFORM_NAMES[platform]}:`);
      const opts = { level, projectDir, platform, dryRun };
      const r = install ? runInstall(opts) : runUninstall(opts);
      if (install && r.changed && !opts.dryRun) console.log(RESTART[platform]);
    }
    if (install) {
      if (dog !== undefined) {
        const changed = saveDog(dogFile, dogDir, dog, dryRun);
        const coat = dog?.coat ? dog.coat.replace("_", " ") : "any coat, one per project";
        const what = dog ? `${dog.breed.replace("_", " ")} (${coat})` : "a different one per project";
        console.log(`\nDog for ${who}: ${what}.`);
        if (changed) console.log(`${dryRun ? "Would save" : "Saved"} in ${dogFile}. Restart the zoomies server (zoomies restart) to see it.`);
      }
      console.log("\nNothing breaks while the zoomies server is stopped.");
    }
  } catch (err) {
    if (err instanceof InstallError || err instanceof ConfigError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case "serve":
      return serve(args);
    case "start":
    case "stop":
    case "restart":
    case "status":
    case "open":
    case "logs":
      return daemonCommand(command, args);
    case "hooks-snippet": {
      for (const platform of parsePlatforms(flagValue(args, "--platform") ?? "claude")) {
        if (platform === "copilot") {
          console.log(`// ${PLATFORM_NAMES.copilot}: .github/hooks/zoomies.json or ~/.copilot/hooks/zoomies.json`);
          console.log(JSON.stringify(copilotHooksFile(), null, 2));
        } else if (platform === "codex") {
          const hooks = Object.fromEntries(PLATFORM_EVENTS.codex.map((e) => [e, [{ hooks: [{ type: "command", command: hookCommand(undefined, "codex"), timeout: 2 }] }]]));
          console.log(`// ${PLATFORM_NAMES.codex}: .codex/hooks.json or ~/.codex/hooks.json`);
          console.log(JSON.stringify({ hooks }, null, 2));
        } else {
          console.log(`// ${PLATFORM_NAMES.claude}: the "hooks" block of a settings.json (all events, for record mode)`);
          console.log(JSON.stringify(hooksSnippet(), null, 2));
        }
      }
      return;
    }
    case "inspect":
      return inspect(args);
    case "replay":
      return replayCommand(args);
    case "art":
      return artMain(args);
    case "install-hooks":
      return hooksCommand(args, true);
    case "uninstall-hooks":
      return hooksCommand(args, false);
    default:
      console.log(USAGE);
      if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
}
