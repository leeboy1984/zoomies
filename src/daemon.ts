import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

/**
 * `zoomies start|stop|restart|status`: the server in the background.
 *
 * The state lives in one folder (run/ in the zoomies checkout, git-ignored):
 * zoomies.pid (JSON: pid, port, start time) and zoomies.log (server output).
 * A pid alone is never trusted: before stopping, the server must answer on
 * /health on its port, so a reused pid is never killed.
 */
export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: number;
}

export interface DaemonOptions {
  /** Folder for zoomies.pid and zoomies.log. */
  dir: string;
  /** bin/zoomies.mjs, run with this same Node. */
  entry: string;
  log?: (line: string) => void;
}

export type DaemonStatus =
  | { state: "running"; info: DaemonInfo }
  /** Something answers on the port, but it was not started with `zoomies start`. */
  | { state: "foreground"; port: number }
  | { state: "stopped" };

/** The log is cut when it grows past this size, on the next start. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const START_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 5000;

export class DaemonError extends Error {}

export const pidFile = (dir: string) => join(dir, "zoomies.pid");
export const logFile = (dir: string) => join(dir, "zoomies.log");

export function readInfo(dir: string): DaemonInfo | null {
  try {
    const info = JSON.parse(readFileSync(pidFile(dir), "utf8")) as DaemonInfo;
    return Number.isInteger(info.pid) && Number.isInteger(info.port) ? info : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Does a zoomies server answer on this port? */
export function ping(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/health", method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 204);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return true;
    await sleep(100);
  }
  return check();
}

/** The last lines of the log, to explain a failed start. */
export function tailLog(dir: string, lines = 20): string {
  if (!existsSync(logFile(dir))) return "";
  return readFileSync(logFile(dir), "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

export async function status(dir: string, port: number): Promise<DaemonStatus> {
  const info = readInfo(dir);
  if (info && isAlive(info.pid) && (await ping(info.port))) return { state: "running", info };
  if (info) rmSync(pidFile(dir), { force: true }); // stale: the process is gone
  if (await ping(port)) return { state: "foreground", port };
  return { state: "stopped" };
}

/** Starts `zoomies serve <serveArgs>` detached and waits until it answers. */
export async function start(opts: DaemonOptions, port: number, serveArgs: string[]): Promise<DaemonInfo> {
  const log = opts.log ?? (() => {});
  const current = await status(opts.dir, port);
  if (current.state === "running") throw new DaemonError(`zoomies is already running on http://127.0.0.1:${current.info.port} (pid ${current.info.pid}).`);
  if (current.state === "foreground") throw new DaemonError(`Port ${port} is already taken by a zoomies server started with "serve". Stop it first (Ctrl+C in its terminal).`);

  mkdirSync(opts.dir, { recursive: true });
  const logPath = logFile(opts.dir);
  const tooBig = existsSync(logPath) && statSync(logPath).size > MAX_LOG_BYTES;
  const fd = openSync(logPath, tooBig ? "w" : "a");
  writeFileSync(fd, `\n--- zoomies start ${new Date().toISOString()} ---\n`);
  const child = spawn(process.execPath, [opts.entry, "serve", "--port", String(port), ...serveArgs], {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  closeSync(fd);
  let exited = false;
  child.on("exit", () => (exited = true));
  child.unref();
  if (child.pid === undefined) throw new DaemonError(`Could not start the server. Log: ${logPath}`);

  const info: DaemonInfo = { pid: child.pid, port, startedAt: Date.now() };
  const up = await waitFor(async () => exited || (await ping(port)), START_TIMEOUT_MS);
  if (!up || exited || !(await ping(port))) {
    if (!exited) process.kill(child.pid, "SIGTERM");
    throw new DaemonError(`The server did not start. Last lines of ${logPath}:\n${tailLog(opts.dir)}`);
  }
  writeFileSync(pidFile(opts.dir), JSON.stringify(info) + "\n");
  log(`zoomies is running on http://127.0.0.1:${port} (pid ${info.pid}). Log: ${logPath}`);
  return info;
}

/** Stops the server started with `start`. Returns false if it was not running. */
export async function stop(opts: DaemonOptions, port: number): Promise<boolean> {
  const log = opts.log ?? (() => {});
  const current = await status(opts.dir, port);
  if (current.state === "foreground") {
    throw new DaemonError(`The zoomies server on port ${port} was started with "serve": stop it with Ctrl+C in its terminal.`);
  }
  if (current.state === "stopped") {
    log("zoomies is not running.");
    return false;
  }
  const { pid } = current.info;
  process.kill(pid, "SIGTERM");
  if (!(await waitFor(() => !isAlive(pid), STOP_TIMEOUT_MS))) {
    throw new DaemonError(`The server (pid ${pid}) did not stop within ${STOP_TIMEOUT_MS / 1000} s.`);
  }
  rmSync(pidFile(opts.dir), { force: true });
  log("zoomies stopped.");
  return true;
}

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
}
