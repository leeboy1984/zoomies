import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Recorder } from "../src/recorder.js";
import { startServer } from "../src/server.js";

const HOOK = fileURLToPath(new URL("../bin/zoomies-hook.cjs", import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runHook(input: string, port: number, args: string[] = []): Promise<Run> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, [HOOK, ...args], { env: { ...process.env, ZOOMIES_PORT: String(port) } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - start }));
    child.stdin.end(input);
  });
}

/** A port nobody is listening on for sure. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

const payload = { session_id: "s1", hook_event_name: "Stop", cwd: "/tmp/p" };

describe("forwarder zoomies-hook", () => {
  it("with the server down: exit 0, no output and fast", async () => {
    const run = await runHook(JSON.stringify(payload), await freePort());
    expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(run.ms).toBeLessThan(1000);
  });

  it("with garbage or empty input: exit 0 and no output", async () => {
    const port = await freePort();
    for (const input of ["", "not json", "{"]) {
      expect(await runHook(input, port)).toMatchObject({ code: 0, stdout: "", stderr: "" });
    }
  });

  it("with a server that never answers: gives up on its own within ~1 s", async () => {
    const hang = createServer(() => {}).listen(0, "127.0.0.1");
    await new Promise((r) => hang.once("listening", r));
    const { port } = hang.address() as { port: number };
    const run = await runHook(JSON.stringify(payload), port);
    hang.close();
    expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(run.ms).toBeLessThan(1500);
  });

  it("delivers the raw payload to the server with the sent-at stamp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zoomies-fwd-"));
    const recorder = new Recorder(dir);
    const srv = await startServer({ port: 0, recorder });
    try {
      const run = await runHook(JSON.stringify(payload), srv.port);
      expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
      await recorder.close();
      const line = JSON.parse(readFileSync(recorder.file, "utf8").trim());
      expect(line.payload).toEqual(payload);
      expect(typeof line.sentAt).toBe("number");
    } finally {
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--source tells the server which host it is (the session shows up as Codex)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zoomies-fwd-"));
    const recorder = new Recorder(dir);
    const srv = await startServer({ port: 0, recorder });
    try {
      const run = await runHook(JSON.stringify({ ...payload, session_id: "codex-1" }), srv.port, ["--source", "codex"]);
      expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
      expect(srv.store.view("codex-1")?.platform).toBe("codex");
      await recorder.close();
      expect(JSON.parse(readFileSync(recorder.file, "utf8").trim()).source).toBe("codex");
    } finally {
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trims huge payloads by dropping the heavy fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zoomies-fwd-"));
    const recorder = new Recorder(dir);
    const srv = await startServer({ port: 0, recorder });
    try {
      const huge = {
        ...payload,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/tmp/p/a.txt", content: "x".repeat(1_500_000) },
        tool_response: { big: "y".repeat(100) },
      };
      await runHook(JSON.stringify(huge), srv.port);
      await recorder.close();
      const line = JSON.parse(readFileSync(recorder.file, "utf8").trim());
      expect(line.payload.tool_input).toEqual({ file_path: "/tmp/p/a.txt" });
      expect(line.payload.tool_response).toBeUndefined();
      expect(line.payload._zoomies_trimmed).toBe(true);
    } finally {
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
