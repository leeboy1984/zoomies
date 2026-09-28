import { readFileSync } from "node:fs";
import type { RecordLine } from "./recorder.js";

/**
 * Summary of a recording WITHOUT sensitive values: event names, field names,
 * and only the values of "catalogue" fields (tool_name, agent_type,
 * notification_type, source, reason, trigger). Meant to be shareable without
 * sharing paths, commands or content.
 */

const CATALOG_FIELDS = ["tool_name", "agent_type", "notification_type", "source", "reason", "trigger"] as const;

type Obj = Record<string, unknown>;

export interface EventSummary {
  count: number;
  /** Top-level field name → number of events that carry it. */
  fields: Record<string, number>;
  /** tool_input fields seen, per tool_name. */
  toolInputFields: Record<string, string[]>;
  /** Values seen for the catalogue fields. */
  values: Record<string, Record<string, number>>;
  /** Events that carry agent_id (fired inside a subagent). */
  withAgentId: number;
}

export interface RecordingSummary {
  lines: number;
  invalidLines: number;
  sessions: number;
  events: Record<string, EventSummary>;
  /** Forwarder → server latency (receivedAt - sentAt), in ms. */
  forwardLatencyMs: { samples: number; p50: number | null; p95: number | null; max: number | null };
  /** Consecutive pairs of the same session received in a different order than sent. */
  outOfOrder: number;
  /** Subagent events whose agent_id matches an earlier SubagentStart. */
  subagentAttribution: { toolEventsInSubagents: number; matchedToSubagentStart: number };
}

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? null;
}

export function summarize(lines: RecordLine[], invalidLines = 0): RecordingSummary {
  const events: Record<string, EventSummary> = {};
  const sessions = new Set<string>();
  const latencies: number[] = [];
  const lastSentBySession = new Map<string, number>();
  const knownAgents = new Set<string>();
  let outOfOrder = 0;
  let toolEventsInSubagents = 0;
  let matchedToSubagentStart = 0;

  for (const line of lines) {
    const p = line.payload;
    if (!isObj(p)) continue;
    const name = typeof p.hook_event_name === "string" ? p.hook_event_name : "(no hook_event_name)";
    const session = typeof p.session_id === "string" ? p.session_id : "";
    sessions.add(session);

    const ev = (events[name] ??= { count: 0, fields: {}, toolInputFields: {}, values: {}, withAgentId: 0 });
    ev.count++;
    for (const key of Object.keys(p)) ev.fields[key] = (ev.fields[key] ?? 0) + 1;
    for (const key of CATALOG_FIELDS) {
      const v = p[key];
      if (typeof v === "string") {
        const bucket = (ev.values[key] ??= {});
        bucket[v] = (bucket[v] ?? 0) + 1;
      }
    }
    if (typeof p.tool_name === "string" && isObj(p.tool_input)) {
      const seen = new Set(ev.toolInputFields[p.tool_name] ?? []);
      for (const key of Object.keys(p.tool_input)) seen.add(key);
      ev.toolInputFields[p.tool_name] = [...seen].sort();
    }

    const agentId = typeof p.agent_id === "string" ? p.agent_id : undefined;
    if (agentId !== undefined) ev.withAgentId++;
    if (name === "SubagentStart" && agentId) knownAgents.add(`${session}/${agentId}`);
    if (agentId && typeof p.tool_name === "string") {
      toolEventsInSubagents++;
      if (knownAgents.has(`${session}/${agentId}`)) matchedToSubagentStart++;
    }

    if (line.sentAt !== null) {
      latencies.push(line.receivedAt - line.sentAt);
      const prev = lastSentBySession.get(session);
      if (prev !== undefined && line.sentAt < prev) outOfOrder++;
      lastSentBySession.set(session, Math.max(prev ?? 0, line.sentAt));
    }
  }

  latencies.sort((a, b) => a - b);
  return {
    lines: lines.length,
    invalidLines,
    sessions: sessions.size,
    events,
    forwardLatencyMs: {
      samples: latencies.length,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length ? (latencies[latencies.length - 1] ?? null) : null,
    },
    outOfOrder,
    subagentAttribution: { toolEventsInSubagents, matchedToSubagentStart },
  };
}

export function readRecording(file: string): { lines: RecordLine[]; invalid: number } {
  const lines: RecordLine[] = [];
  let invalid = 0;
  for (const text of readFileSync(file, "utf8").split("\n")) {
    if (!text.trim()) continue;
    try {
      lines.push(JSON.parse(text) as RecordLine);
    } catch {
      invalid++;
    }
  }
  return { lines, invalid };
}
