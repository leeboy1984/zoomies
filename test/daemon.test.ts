import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonError, formatUptime, pidFile, ping, readInfo, start, status, stop, tailLog } from "../src/daemon.js";
import { startServer } from "../src/server.js";

// Runs the built CLI (npm test builds dist/ first).
const ENTRY = fileURLToPath(new URL("../bin/zoomies.mjs", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

describe("zoomies start / stop / status", () => {
  let dir = "";
  afterEach(async () => {
    const info = readInfo(dir);
    if (info) await stop({ dir, entry: ENTRY }, info.port).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts in the background, refuses a second start, and stops", async () => {
    dir = mkdtempSync(join(tmpdir(), "zoomies-run-"));
    const port = await freePort();
    expect((await status(dir, port)).state).toBe("stopped");

    const info = await start({ dir, entry: ENTRY }, port, []);
    expect(info.port).toBe(port);
    expect(await ping(port)).toBe(true);
    expect(await status(dir, port)).toEqual({ state: "running", info });
    expect(tailLog(dir)).toContain(`listening on http://127.0.0.1:${port}`);
    await expect(start({ dir, entry: ENTRY }, port, [])).rejects.toThrow(/already running/);

    expect(await stop({ dir, entry: ENTRY }, port)).toBe(true);
    expect(await ping(port)).toBe(false);
    expect(readInfo(dir)).toBeNull();
    expect(await stop({ dir, entry: ENTRY }, port)).toBe(false);
  }, 20000);

  it("cleans a stale pid file and never kills a pid that does not answer on its port", async () => {
    dir = mkdtempSync(join(tmpdir(), "zoomies-run-"));
    const port = await freePort();
    // Our own pid: alive, but no zoomies server answers on that port.
    writeFileSync(pidFile(dir), JSON.stringify({ pid: process.pid, port, startedAt: 0 }));
    expect((await status(dir, port)).state).toBe("stopped");
    expect(readInfo(dir)).toBeNull();
    expect(await stop({ dir, entry: ENTRY }, port)).toBe(false);
  });

  it("does not touch a server started with serve", async () => {
    dir = mkdtempSync(join(tmpdir(), "zoomies-run-"));
    const srv = await startServer({ port: 0 });
    try {
      expect(await status(dir, srv.port)).toEqual({ state: "foreground", port: srv.port });
      await expect(start({ dir, entry: ENTRY }, srv.port, [])).rejects.toThrow(DaemonError);
      await expect(stop({ dir, entry: ENTRY }, srv.port)).rejects.toThrow(/Ctrl\+C/);
    } finally {
      await srv.close();
    }
  });

  it("reports a server that fails to start, with its log", async () => {
    dir = mkdtempSync(join(tmpdir(), "zoomies-run-"));
    const port = await freePort();
    await expect(start({ dir, entry: ENTRY }, port, ["--config", join(dir, "missing.json")])).rejects.toThrow(/did not start[\s\S]*does not exist/);
    expect(readInfo(dir)).toBeNull();
  }, 20000);

  it("formats uptimes", () => {
    expect(formatUptime(5000)).toBe("5 s");
    expect(formatUptime(3 * 60_000)).toBe("3 min");
    expect(formatUptime(125 * 60_000)).toBe("2 h 5 min");
    expect(formatUptime(26 * 3_600_000)).toBe("1 d 2 h");
  });
});
