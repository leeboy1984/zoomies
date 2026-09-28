import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DOG_STATES, PUPPY_STATES, TRAINER_STATES, UI_ONLY_STATES } from "../src/mapping/table.js";
import { parseReplay, readReplayFile, realDelays, renameSessions, replay } from "../src/replay.js";
import { startServer, type ServerMessage } from "../src/server.js";

const DEMO = fileURLToPath(new URL("../examples/demo.jsonl", import.meta.url));

describe("replay: parsing", () => {
  it("reads recordings with their original timing", () => {
    const text = [
      { v: 1, receivedAt: 1000, sentAt: 998, payload: { hook_event_name: "SessionStart", session_id: "s" } },
      { v: 1, receivedAt: 1500, sentAt: 1497, payload: { hook_event_name: "Stop", session_id: "s" } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    expect(parseReplay(text).map((s) => s.delayMs)).toEqual([0, 500]);
  });

  it("reads hand-written payloads with optional _delayMs", () => {
    const text = [
      JSON.stringify({ hook_event_name: "SessionStart", session_id: "s" }),
      JSON.stringify({ hook_event_name: "Stop", session_id: "s", _delayMs: 2000 }),
      JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s" }),
    ].join("\n");
    const steps = parseReplay(text);
    expect(steps.map((s) => s.delayMs)).toEqual([0, 2000, 500]);
    expect(steps[1]?.payload).not.toHaveProperty("_delayMs");
  });

  it("rejects lines that are not events", () => {
    expect(() => parseReplay('{"hello":1}')).toThrow(/line 1/);
    expect(() => parseReplay("{broken")).toThrow(/line 1/);
  });

  it("speeds up and trims long waits", () => {
    const steps = [0, 1000, 60_000].map((delayMs) => ({ delayMs, payload: {} }));
    expect(realDelays(steps, 2, Infinity)).toEqual([0, 500, 30_000]);
    expect(realDelays(steps, 1, 5_000)).toEqual([0, 1000, 5_000]);
  });

  it("renames sessions consistently", () => {
    const steps = ["a", "b", "a"].map((session_id) => ({ delayMs: 0, payload: { session_id } }));
    const ids = renameSessions(steps).map((s) => s.payload.session_id as string);
    expect(ids[0]).toBe(ids[2]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toMatch(/^replay-a-[0-9a-f]{6}$/);
  });
});

describe("replaying examples/demo.jsonl", () => {
  it("animates end to end: goes through every state and finishes cleanly", async () => {
    const srv = await startServer({ port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Origin: `http://127.0.0.1:${srv.port}` } });
    const messages: ServerMessage[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise((r) => ws.once("open", r));

    try {
      const steps = readReplayFile(DEMO);
      const result = await replay(steps, { port: srv.port, speed: 1000, maxGapMs: 5, keepIds: true });
      expect(result).toEqual({ sent: steps.length, accepted: steps.length });
      await new Promise((r) => setTimeout(r, 50));

      const seen = { dog: new Set<string>(), trainer: new Set<string>(), puppy: new Set<string>(), bucket: new Set<string>() };
      for (const m of messages) {
        if (m.type !== "session") continue;
        seen.dog.add(m.session.companion.state);
        seen.trainer.add(m.session.trainer.state);
        seen.bucket.add(m.session.bucket);
        for (const p of m.session.puppies) seen.puppy.add(p.state);
      }
      const dogStates = DOG_STATES.filter((s) => !UI_ONLY_STATES.includes(s));
      expect(dogStates.filter((s) => !seen.dog.has(s))).toEqual([]);
      expect(TRAINER_STATES.filter((s) => !seen.trainer.has(s))).toEqual([]);
      expect(["dashes_off", "returns"].filter((s) => !seen.puppy.has(s))).toEqual([]);
      expect([...seen.bucket].sort()).toEqual(["done", "ended", "needs_you", "working"]);
      expect(PUPPY_STATES.length).toBeGreaterThan(DOG_STATES.length);

      const a = srv.store.view("demo-aaaa-0001");
      const b = srv.store.view("demo-bbbb-0002");
      expect(a).toMatchObject({ project: "kennel-app", bucket: "ended", obstacles: 3 });
      expect(b).toMatchObject({ project: "blog", bucket: "done" });
      expect(b?.companion.state).toBe("celebrates");
    } finally {
      ws.close();
      await srv.close();
    }
  });

  it("without a server gives a clear error", async () => {
    await expect(replay([{ delayMs: 0, payload: { hook_event_name: "Stop", session_id: "s" } }], { port: 1, speed: 1, maxGapMs: 0, keepIds: true })).rejects.toThrow(/zoomies serve/);
  });
});
