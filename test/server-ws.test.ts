import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startServer, type ServerMessage, type ZoomiesServer } from "../src/server.js";
import * as f from "./fixtures/payloads.js";

function post(port: number, payload: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request(
      { host: "127.0.0.1", port, method: "POST", path: "/event", headers: { "Content-Type": "application/json" } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Tries to open the WebSocket; resolves with the first message or the HTTP rejection code. */
function connect(
  port: number,
  headers: Record<string, string>,
): Promise<{ ws: WebSocket; messages: ServerMessage[]; first: ServerMessage } | { rejected: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const messages: ServerMessage[] = [];
    ws.on("unexpected-response", (_req, res) => resolve({ rejected: res.statusCode ?? 0 }));
    ws.on("error", () => resolve({ rejected: -1 }));
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      messages.push(msg);
      if (messages.length === 1) resolve({ ws, messages, first: msg });
    });
  });
}

const until = async (cond: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("server: WebSocket and state", () => {
  let srv: ZoomiesServer;
  const origin = () => `http://127.0.0.1:${srv.port}`;

  beforeEach(async () => {
    srv = await startServer({ port: 0, rateLimit: { limit: 10, windowMs: 60_000 } });
  });
  afterEach(() => srv.close());

  it("accepts the WebSocket from a local origin and sends a snapshot", async () => {
    const res = await connect(srv.port, { Origin: origin() });
    expect("ws" in res).toBe(true);
    if ("ws" in res) {
      expect(res.first).toEqual({ type: "snapshot", sessions: [] });
      res.ws.close();
    }
    const alt = await connect(srv.port, { Origin: `http://localhost:${srv.port}` });
    expect("ws" in alt).toBe(true);
    if ("ws" in alt) alt.ws.close();
  });

  it("rejects the WebSocket from any other page", async () => {
    expect(await connect(srv.port, { Origin: "https://evil.example" })).toEqual({ rejected: 403 });
    expect(await connect(srv.port, { Origin: "http://127.0.0.1:1" })).toEqual({ rejected: 403 });
    expect(await connect(srv.port, { Origin: "null" })).toEqual({ rejected: 403 });
    // No Origin (not a browser): rejected too.
    expect(await connect(srv.port, {})).toEqual({ rejected: 403 });
  });

  it("rejects the WebSocket with a foreign Host even if the Origin looks local (DNS rebinding)", async () => {
    const res = await connect(srv.port, { Origin: origin(), Host: `evil.example:${srv.port}` });
    expect(res).toEqual({ rejected: 403 });
  });

  it("broadcasts the session state when an event arrives, with no sensitive data", async () => {
    const res = await connect(srv.port, { Origin: origin() });
    if (!("ws" in res)) throw new Error("did not connect");
    const sensitive = [
      f.userPrompt(),
      f.preTool("Write", f.writeInput),
      f.postTool("Write", f.writeInput, { filePath: f.writeInput.file_path, content: "SECRET RESPONSE" }),
      f.preTool("Edit", f.editInput),
      f.preTool("Agent", f.agentInput("Explore", "Look things up")),
      f.stop(),
    ];
    for (const p of sensitive) expect(await post(srv.port, p)).toBe(204);
    await until(() => res.messages.length > sensitive.length);

    const last = res.messages[res.messages.length - 1];
    expect(last?.type).toBe("session");
    if (last?.type === "session") {
      expect(last.session.project).toBe("my-app");
      expect(last.session.companion.state).toBe("celebrates");
    }
    const wire = JSON.stringify(res.messages);
    for (const secret of [
      "hunter2",
      "SECRET CONTENT",
      "SECRET RESPONSE",
      "SECRET_A",
      "SECRET_B",
      "SECRET PROMPT",
      "src/secret.ts",
      "transcript",
      ".claude/projects",
      f.CWD,
    ]) {
      expect(wire).not.toContain(secret);
    }
    res.ws.close();
  });

  it("rate-limits events per session", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push(await post(srv.port, f.userPrompt()));
    expect(codes.slice(0, 10).every((c) => c === 204)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it("rejects payloads that are not hook events", async () => {
    expect(await post(srv.port, { hello: "dog" })).toBe(400);
    expect(await post(srv.port, { hook_event_name: "Stop", session_id: "../../etc/passwd" })).toBe(400);
  });
});
