import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Recorder } from "../src/recorder.js";
import { startServer, type ZoomiesServer } from "../src/server.js";

interface Res {
  status: number;
  body: string;
}

function post(port: number, body: string, headers: Record<string, string> = {}, path = "/event"): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: { "Content-Type": "application/json", Host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    // When the server rejects a large body early, the rest of our write fails after
    // the response has already arrived: that is expected, not a test failure.
    req.on("socket", (socket) => socket.on("error", () => {}));
    req.end(body);
  });
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

const sample = JSON.stringify({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Read" });

describe("server /event", () => {
  let dir: string;
  let recorder: Recorder;
  let srv: ZoomiesServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "zoomies-test-"));
    recorder = new Recorder(dir);
    srv = await startServer({ port: 0, recorder });
  });

  afterEach(async () => {
    await srv.close();
    await recorder.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("listens only on 127.0.0.1", () => {
    expect(srv.server.address()).toMatchObject({ address: "127.0.0.1" });
  });

  it("accepts a valid event with 204 and an empty body, and records it", async () => {
    const res = await post(srv.port, sample, { "X-Zoomies-Sent-At": "1700000000000" });
    expect(res).toEqual({ status: 204, body: "" });
    await recorder.close();
    const line = JSON.parse(readFileSync(recorder.file, "utf8").trim());
    expect(line.v).toBe(1);
    expect(line.sentAt).toBe(1700000000000);
    expect(line.payload).toEqual(JSON.parse(sample));
  });

  it("accepts Host localhost:<port>", async () => {
    expect((await post(srv.port, sample, { Host: `localhost:${srv.port}` })).status).toBe(204);
  });

  it("rejects requests with Origin (browser)", async () => {
    expect((await post(srv.port, sample, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post(srv.port, sample, { Origin: `http://127.0.0.1:${srv.port}` })).status).toBe(403);
  });

  it("rejects a foreign Host (DNS rebinding)", async () => {
    expect((await post(srv.port, sample, { Host: `evil.example:${srv.port}` })).status).toBe(403);
    expect((await post(srv.port, sample, { Host: "127.0.0.1:1" })).status).toBe(403);
  });

  it("rejects a non-JSON Content-Type", async () => {
    expect((await post(srv.port, sample, { "Content-Type": "text/plain" })).status).toBe(415);
  });

  it("rejects invalid JSON or JSON that is not an object", async () => {
    expect((await post(srv.port, "{nope")).status).toBe(400);
    expect((await post(srv.port, "[1,2]")).status).toBe(400);
  });

  it("rejects bodies that are too large", async () => {
    const big = JSON.stringify({ x: "a".repeat(3 * 1024 * 1024) });
    expect((await post(srv.port, big)).status).toBe(413);
  });

  it("only accepts POST on /event and no POST on other routes", async () => {
    expect((await post(srv.port, sample, {}, "/nope")).status).toBe(405);
    expect((await get(srv.port, "/event")).status).toBe(405);
  });

  it("serves public/ with security headers and never leaves the folder", async () => {
    const ok = await get(srv.port, "/art/sprites.json");
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toMatch(/application\/json/);
    expect(ok.headers["content-security-policy"]).toMatch(/default-src 'self'/);
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "/art/../../src/server.ts", "/nope.html", "/js/"]) {
      expect((await get(srv.port, path)).status).toBe(404);
    }
    expect((await get(srv.port, "/art/sprites.json", { Host: "evil.example" })).status).toBe(403);
  });

  it("creates the recording with user-only permissions", () => {
    if (process.platform === "win32") return;
    expect(statSync(recorder.file).mode & 0o077).toBe(0);
  });
});
