import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { readFileSync } from "node:fs";

/**
 * zoomies replay: replays a JSONL recording against a running server, with the
 * original timing (or sped up). It goes through the same /event endpoint as the
 * forwarder, so it exercises the real mapper.
 *
 * Accepted line formats:
 * - `serve --record` recording: {"v":1,"receivedAt":…,"sentAt":…,"payload":{…}}
 * - Bare payload (hand-written): {"hook_event_name":…, …}, optionally with
 *   "_delayMs" = wait since the previous event (500 ms by default).
 */

export interface ReplayStep {
  /** Wait before sending this event, in ms of the original recording. */
  delayMs: number;
  /** Host that emitted it (codex, copilot), sent on as the forwarder would. */
  source?: string;
  payload: Record<string, unknown>;
}

export interface ReplayOptions {
  port: number;
  /** 2 = twice as fast. */
  speed: number;
  /** Cap on the wait between events (real ms, after applying speed); Infinity = no cap. */
  maxGapMs: number;
  /** Keep the original session_id values instead of generating new ones. */
  keepIds: boolean;
  onEvent?: (step: ReplayStep, index: number, total: number) => void;
}

const DEFAULT_HANDWRITTEN_DELAY_MS = 500;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

export function parseReplay(text: string): ReplayStep[] {
  const steps: ReplayStep[] = [];
  let prevAt: number | null = null;
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new Error(`line ${i + 1}: invalid JSON`);
    }
    if (!isObj(obj)) throw new Error(`line ${i + 1}: not an object`);

    if (isObj(obj.payload) && typeof obj.receivedAt === "number") {
      // Recording format.
      const at = obj.receivedAt;
      const source = typeof obj.source === "string" ? obj.source : undefined;
      steps.push({ delayMs: prevAt === null ? 0 : Math.max(0, at - prevAt), payload: obj.payload, ...(source ? { source } : {}) });
      prevAt = at;
    } else if (typeof obj.hook_event_name === "string") {
      // Hand-written payload.
      const { _delayMs, ...payload } = obj;
      const delay = typeof _delayMs === "number" && _delayMs >= 0 ? _delayMs : DEFAULT_HANDWRITTEN_DELAY_MS;
      steps.push({ delayMs: steps.length === 0 ? 0 : delay, payload });
    } else {
      throw new Error(`line ${i + 1}: neither a recording nor a hook payload`);
    }
  }
  return steps;
}

/** Real wait before each step. */
export function realDelays(steps: ReplayStep[], speed: number, maxGapMs: number): number[] {
  if (!(speed > 0)) throw new Error("speed must be > 0");
  return steps.map((s) => Math.min(s.delayMs / speed, maxGapMs));
}

/** Gives every session in the recording a new id, so it never collides with real sessions or another replay. */
export function renameSessions(steps: ReplayStep[]): ReplayStep[] {
  const map = new Map<string, string>();
  const suffix = randomBytes(3).toString("hex");
  return steps.map((s) => {
    const id = s.payload.session_id;
    if (typeof id !== "string") return s;
    let renamed = map.get(id);
    if (!renamed) {
      renamed = `replay-${id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8)}-${suffix}`;
      map.set(id, renamed);
    }
    return { ...s, payload: { ...s.payload, session_id: renamed } };
  });
}

function post(port: number, payload: Obj, source?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/event",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...(source ? { "X-Zoomies-Source": source } : {}),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Returns how many events the server accepted. */
export async function replay(steps: ReplayStep[], opts: ReplayOptions): Promise<{ sent: number; accepted: number }> {
  const run = opts.keepIds ? steps : renameSessions(steps);
  const delays = realDelays(run, opts.speed, opts.maxGapMs);
  let accepted = 0;
  for (const [i, step] of run.entries()) {
    const wait = delays[i] ?? 0;
    if (wait > 0) await sleep(wait);
    let status: number;
    try {
      status = await post(opts.port, step.payload, step.source);
    } catch {
      throw new Error(`no server on 127.0.0.1:${opts.port} (start it with: zoomies serve)`);
    }
    if (status === 204) accepted++;
    opts.onEvent?.(step, i, run.length);
  }
  return { sent: run.length, accepted };
}

export function readReplayFile(file: string): ReplayStep[] {
  return parseReplay(readFileSync(file, "utf8"));
}
