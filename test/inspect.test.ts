import { describe, expect, it } from "vitest";
import { summarize } from "../src/inspect.js";
import type { RecordLine } from "../src/recorder.js";

const line = (payload: Record<string, unknown>, sentAt: number, receivedAt = sentAt + 5): RecordLine => ({
  v: 1,
  receivedAt,
  sentAt,
  payload,
});

describe("inspect", () => {
  const lines = [
    line({ session_id: "s", hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" }, 100),
    line(
      {
        session_id: "s",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "cat /secret/path" },
        agent_id: "a1",
        agent_type: "Explore",
      },
      200,
    ),
    line({ session_id: "s", hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/secret/x" } }, 150),
  ];
  const summary = summarize(lines);

  it("counts events, fields and catalogue values", () => {
    expect(summary.events.PreToolUse?.count).toBe(2);
    expect(summary.events.PreToolUse?.values.tool_name).toEqual({ Bash: 1, Read: 1 });
    expect(summary.events.PreToolUse?.toolInputFields).toEqual({ Bash: ["command"], Read: ["file_path"] });
    expect(summary.events.PreToolUse?.withAgentId).toBe(1);
  });

  it("detects subagent attribution and out-of-order events", () => {
    expect(summary.subagentAttribution).toEqual({ toolEventsInSubagents: 1, matchedToSubagentStart: 1 });
    expect(summary.outOfOrder).toBe(1);
    expect(summary.forwardLatencyMs.p50).toBe(5);
  });

  it("includes no sensitive values", () => {
    const text = JSON.stringify(summary);
    expect(text).not.toContain("secret");
  });
});
