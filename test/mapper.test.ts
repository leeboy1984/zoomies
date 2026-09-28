import { describe, expect, it } from "vitest";
import { sanitize } from "../src/mapping/sanitize.js";
import {
  DOG_STATES,
  BREED_COATS,
  OTHER_BREEDS,
  TRAINER_SKINS,
  TRAINER_STYLES,
  PUPPY_STATES,
  TRAINER_STATES,
  UI_ONLY_STATES,
  type DogState,
  type PuppyState,
  type TrainerState,
} from "../src/mapping/table.js";
import { SessionStore, companionLookFor, type Bucket, type SessionView } from "../src/state/store.js";
import * as f from "./fixtures/payloads.js";

/**
 * Case table: sequence of raw payloads → expected final state.
 * Every state in the mapping table must appear in at least one case
 * (checked by the last test).
 */
interface Case {
  name: string;
  events: Record<string, unknown>[];
  companion?: DogState;
  trainer?: TrainerState;
  puppy?: { id: string; state: PuppyState };
  bucket?: Bucket;
  obstacles?: number;
}

const bash = f.bashInput;
const cases: Case[] = [
  // Companion and trainer (main agent)
  { name: "SessionStart", events: [f.sessionStart()], companion: "arrives", trainer: "enters" },
  { name: "UserPromptSubmit", events: [f.sessionStart(), f.userPrompt()], companion: "alert", trainer: "idle", bucket: "working" },
  { name: "PreToolUse Read", events: [f.preTool("Read", f.readInput)], companion: "reads", trainer: "notebook" },
  { name: "PreToolUse Grep", events: [f.preTool("Grep", { pattern: "TODO" })], companion: "sniffs", trainer: "notebook" },
  { name: "PreToolUse Glob", events: [f.preTool("Glob", { pattern: "**/*.ts" })], companion: "sniffs", trainer: "notebook" },
  { name: "PreToolUse Edit", events: [f.preTool("Edit", f.editInput)], companion: "digs", trainer: "notebook" },
  { name: "PreToolUse Write", events: [f.preTool("Write", f.writeInput)], companion: "digs", trainer: "notebook" },
  { name: "PreToolUse MultiEdit", events: [f.preTool("MultiEdit", f.editInput)], companion: "digs" },
  { name: "PreToolUse Bash", events: [f.preTool("Bash", bash)], companion: "runs", trainer: "stopwatch" },
  { name: "PreToolUse WebFetch", events: [f.preTool("WebFetch", { url: "https://example.com/a?b" })], companion: "fetches" },
  { name: "PreToolUse WebSearch", events: [f.preTool("WebSearch", { query: "dogs" })], companion: "fetches" },
  { name: "PreToolUse TodoWrite", events: [f.preTool("TodoWrite", { todos: [] })], companion: "agility" },
  { name: "PreToolUse TaskUpdate", events: [f.preTool("TaskUpdate", { taskId: "1", status: "in_progress" })], companion: "agility" },
  { name: "PreToolUse unknown MCP tool", events: [f.preTool("mcp__x__y", {})], companion: "alert", trainer: "idle" },
  { name: "PreToolUse Agent (whistles)", events: [f.preTool("Agent", f.agentInput("Explore", "Search"))], trainer: "whistles" },
  { name: "PreToolUse Task (old name)", events: [f.preTool("Task", f.agentInput("Plan", "Plan it"))], trainer: "whistles" },
  { name: "PostToolUse goes back to idle", events: [f.preTool("Read", f.readInput), f.postTool("Read", f.readInput, { ok: 1 })], companion: "idle", trainer: "idle" },
  { name: "PostToolUseFailure", events: [f.preTool("Bash", bash), f.toolFailure("Bash", bash)], companion: "sad", trainer: "idle" },
  { name: "PostToolUseFailure from an interrupt (Esc)", events: [f.preTool("Bash", bash), f.toolFailure("Bash", bash, true)], companion: "idle" },
  { name: "PermissionRequest", events: [f.preTool("Bash", bash), f.permissionRequest("Bash", bash)], companion: "asks", trainer: "points", bucket: "needs_you" },
  { name: "permission granted: PostToolUse clears asks and points", events: [f.permissionRequest("Bash", bash), f.postTool("Bash", bash, "ok")], companion: "idle", trainer: "idle", bucket: "working" },
  { name: "permission denied by hand: Stop clears asks", events: [f.userPrompt(), f.permissionRequest("Bash", bash), f.stop()], companion: "celebrates", trainer: "celebrates", bucket: "done" },
  { name: "PermissionDenied (auto mode)", events: [f.permissionDenied("Bash", bash)], companion: "sad", trainer: "idle" },
  { name: "Notification permission_prompt without a previous PermissionRequest", events: [f.notification("permission_prompt")], companion: "asks", trainer: "points" },
  { name: "Notification idle_prompt changes nothing", events: [f.stop(), f.notification("idle_prompt")], companion: "celebrates" },
  { name: "PreCompact", events: [f.preCompact()], companion: "shakes" },
  { name: "SessionStart compact after PreCompact is not an arrival", events: [f.sessionStart(), f.userPrompt(), f.preCompact(), f.sessionStart("compact")], companion: "idle", trainer: "idle" },
  { name: "Stop", events: [f.userPrompt(), f.stop()], companion: "celebrates", trainer: "celebrates", bucket: "done" },
  { name: "StopFailure", events: [f.userPrompt(), f.stopFailure()], companion: "sad", trainer: "idle", bucket: "done" },
  { name: "SessionEnd", events: [f.sessionStart(), f.sessionEnd()], companion: "leaves", trainer: "leaves", bucket: "ended" },

  // Puppies
  { name: "SubagentStart", events: [f.subagentStart("a1", "Explore")], puppy: { id: "a1", state: "dashes_off" }, bucket: "working" },
  {
    name: "a tool inside a subagent goes to the puppy",
    events: [f.preTool("Read", f.readInput), f.subagentStart("a1", "Explore"), f.preTool("Grep", { pattern: "x" }, f.inAgent("a1", "Explore"))],
    puppy: { id: "a1", state: "sniffs" },
    companion: "reads",
  },
  {
    name: "a subagent's permission: puppy asks and trainer points",
    events: [f.subagentStart("a1", "general-purpose"), f.permissionRequest("Bash", bash, f.inAgent("a1", "general-purpose"))],
    puppy: { id: "a1", state: "asks" },
    trainer: "points",
    bucket: "needs_you",
  },
  { name: "SubagentStop", events: [f.subagentStart("a1", "Plan"), f.subagentStop("a1", "Plan")], puppy: { id: "a1", state: "returns" } },
  {
    name: "failure inside a subagent",
    events: [f.subagentStart("a1", "Explore"), f.toolFailure("Bash", bash, false, f.inAgent("a1", "Explore"))],
    puppy: { id: "a1", state: "sad" },
  },

  // Agility
  { name: "TaskCompleted adds an obstacle", events: [f.taskCompleted("1"), f.taskCompleted("2")], obstacles: 2 },
  {
    name: "TaskCompleted and TaskUpdate of the same task count once",
    events: [f.taskCompleted("7"), f.postTool("TaskUpdate", { taskId: "7", status: "completed" }, {})],
    obstacles: 1,
  },
  {
    name: "TodoWrite counts completed tasks without repeats",
    events: [
      f.postTool("TodoWrite", { todos: [{ content: "a", status: "completed", activeForm: "A" }, { content: "b", status: "pending", activeForm: "B" }] }, {}),
      f.postTool("TodoWrite", { todos: [{ content: "a", status: "completed", activeForm: "A" }, { content: "b", status: "completed", activeForm: "B" }] }, {}),
    ],
    obstacles: 2,
  },
];

function run(events: Record<string, unknown>[], store = new SessionStore()): SessionView {
  let t = 1_000;
  for (const raw of events) {
    const ev = sanitize(raw);
    if (!ev) throw new Error(`invalid payload: ${JSON.stringify(raw)}`);
    store.apply(ev, (t += 100));
  }
  const view = store.view(f.SESSION);
  if (!view) throw new Error("no session");
  return view;
}

describe("mapper: event → state", () => {
  for (const c of cases) {
    it(c.name, () => {
      const view = run(c.events);
      if (c.companion) expect(view.companion.state).toBe(c.companion);
      if (c.trainer) expect(view.trainer.state).toBe(c.trainer);
      if (c.bucket) expect(view.bucket).toBe(c.bucket);
      if (c.obstacles !== undefined) expect(view.obstacles).toBe(c.obstacles);
      if (c.puppy) expect(view.puppies.find((p) => p.id === c.puppy?.id)?.state).toBe(c.puppy.state);
    });
  }

  it("covers every state in the table (except the ones the UI decides)", () => {
    const dog = new Set(cases.flatMap((c) => [c.companion, c.puppy?.state]).filter(Boolean));
    const trainer = new Set(cases.map((c) => c.trainer).filter(Boolean));
    const missingDog = PUPPY_STATES.filter((s) => !dog.has(s) && !UI_ONLY_STATES.includes(s as DogState));
    const missingTrainer = TRAINER_STATES.filter((s) => !trainer.has(s));
    expect({ missingDog, missingTrainer }).toEqual({ missingDog: [], missingTrainer: [] });
    expect(DOG_STATES.every((s) => PUPPY_STATES.includes(s))).toBe(true);
  });
});

describe("puppies", () => {
  it("breed by agent_type, hashed breed for types without one and a coat of its breed; per-project companion", () => {
    const view = run([f.subagentStart("a1", "Explore"), f.subagentStart("a2", "Plan"), f.subagentStart("a3", "general-purpose"), f.subagentStart("a4", "security-reviewer")]);
    const byId = Object.fromEntries(view.puppies.map((p) => [p.id, p]));
    expect(byId.a1?.breed).toBe("beagle");
    expect(byId.a2?.breed).toBe("border_collie");
    expect(byId.a3?.breed).toBe("mutt");
    expect(OTHER_BREEDS).toContain(byId.a4?.breed);
    for (const p of view.puppies) expect(BREED_COATS[p.breed]).toContain(p.coat);
    expect(view.companionLook).toEqual(companionLookFor(f.CWD));
    expect(TRAINER_STYLES).toContain(view.trainerLook.style);
    expect(TRAINER_SKINS).toContain(view.trainerLook.skin);
  });

  it("takes its name from the pending PreToolUse(Agent) of the same type (FIFO)", () => {
    const view = run([
      f.preTool("Agent", f.agentInput("Plan", "Design the API")),
      f.preTool("Agent", f.agentInput("Explore", "Find login usages")),
      f.subagentStart("a1", "Explore"),
      f.subagentStart("a2", "Plan"),
    ]);
    expect(view.puppies.find((p) => p.id === "a1")?.name).toBe("Find login usages");
    expect(view.puppies.find((p) => p.id === "a2")?.name).toBe("Design the API");
  });

  it("links through tool_response.agentId when PostToolUse(Agent) arrives before SubagentStart", () => {
    const pre = f.preTool("Agent", f.agentInput("Explore", "Explore the tests"));
    const post = f.postTool("Agent", f.agentInput("Explore", "Explore the tests"), { agentId: "a9", status: "async_launched" }, { tool_use_id: pre.tool_use_id });
    const view = run([pre, post, f.subagentStart("a9", "Explore")]);
    expect(view.puppies[0]?.name).toBe("Explore the tests");
  });

  it("creates a ghost puppy when activity arrives from an unknown agent_id", () => {
    const view = run([f.preTool("Read", f.readInput, f.inAgent("zz", "Explore"))]);
    expect(view.puppies).toHaveLength(1);
    expect(view.puppies[0]).toMatchObject({ id: "zz", state: "reads", breed: "beagle" });
    expect(view.companion.state).toBe("idle");
  });

  it("ignores SubagentStop from unknown agents (Claude Code internal agents)", () => {
    const view = run([f.userPrompt(), f.subagentStop("interno", "")]);
    expect(view.puppies).toHaveLength(0);
  });

  it("respects the maximum number of puppies per session", () => {
    const store = new SessionStore({ maxPuppies: 2 });
    const view = run([f.subagentStart("a1", "Explore"), f.subagentStart("a2", "Explore"), f.subagentStart("a3", "Explore")], store);
    expect(view.puppies.map((p) => p.id)).toEqual(["a1", "a2"]);
  });

  it("SessionEnd sends every puppy back", () => {
    const view = run([f.subagentStart("a1", "Explore"), f.sessionEnd()]);
    expect(view.puppies[0]?.state).toBe("returns");
  });
});

describe("expiry", () => {
  const opts = { sessionIdleMs: 10_000, endedLingerMs: 1_000, puppyZombieMs: 5_000, puppyLeaveMs: 500 };

  it("a returning puppy disappears after the animation", () => {
    const store = new SessionStore(opts);
    run([f.subagentStart("a1", "Explore"), f.subagentStop("a1", "Explore")], store);
    expect(store.sweep(1_000 + 200 + 400).changed).toEqual([]);
    expect(store.sweep(1_000 + 200 + 600).changed).toEqual([f.SESSION]);
    expect(store.view(f.SESSION)?.puppies).toHaveLength(0);
  });

  it("a puppy without events is considered a zombie and returns", () => {
    const store = new SessionStore(opts);
    run([f.subagentStart("a1", "Explore")], store);
    store.sweep(1_100 + 5_001);
    expect(store.view(f.SESSION)?.puppies[0]?.state).toBe("returns");
  });

  it("an idle session is removed", () => {
    const store = new SessionStore(opts);
    run([f.userPrompt()], store);
    expect(store.sweep(1_100 + 10_001).removed).toEqual([f.SESSION]);
    expect(store.view(f.SESSION)).toBeNull();
  });

  it("an ended session is removed after a while", () => {
    const store = new SessionStore(opts);
    run([f.sessionStart(), f.sessionEnd()], store);
    expect(store.sweep(1_200 + 900).removed).toEqual([]);
    expect(store.sweep(1_200 + 1_001).removed).toEqual([f.SESSION]);
  });
});

describe("session view", () => {
  it("project name = folder; scene stable per cwd", () => {
    const a = run([f.sessionStart()]);
    const b = run([f.sessionStart()]);
    expect(a.project).toBe("my-app");
    expect(a.scenario).toBe(b.scenario);
    expect(["park", "forest", "beach", "square", "snow"]).toContain(a.scenario);
  });

  it("bubbles: file name, truncated first line of the command, URL host", () => {
    expect(run([f.preTool("Read", f.readInput)]).companion.detail).toBe("login.ts");
    const cmd = run([f.preTool("Bash", f.bashInput)]).companion.detail ?? "";
    expect(cmd.length).toBeLessThanOrEqual(40);
    expect(cmd.startsWith("npm test")).toBe(true);
    expect(cmd).not.toContain("second");
    expect(run([f.preTool("WebFetch", { url: "https://docs.example.com/x?token=abc" })]).companion.detail).toBe("docs.example.com");
    expect(run([f.permissionRequest("Bash", { command: "rm -rf node_modules" })]).companion.detail).toBe("Bash: rm -rf node_modules");
  });
});

describe("tools running in parallel", () => {
  const pre = (tool: string, input: Record<string, unknown>, id: string) => f.preTool(tool, input, { tool_use_id: id });
  const post = (tool: string, input: Record<string, unknown>, id: string) => f.postTool(tool, input, {}, { tool_use_id: id });
  const search = { query: "dog agility" };

  it("keeps fetching while another search is still running, and counts them", () => {
    const store = new SessionStore();
    expect(run([f.userPrompt(), pre("WebSearch", search, "s1"), pre("WebFetch", { url: "https://a.example/x" }, "s2")], store).fetching).toBe(2);
    const afterFirst = run([post("WebSearch", search, "s1")], store);
    expect(afterFirst.companion.state).toBe("fetches");
    expect(afterFirst.fetching).toBe(1);
    const afterBoth = run([post("WebFetch", { url: "https://a.example/x" }, "s2")], store);
    expect(afterBoth.companion.state).toBe("idle");
    expect(afterBoth.fetching).toBe(0);
  });

  it("falls back to the tool still running (a Read finishing while a Grep runs)", () => {
    const view = run([pre("Grep", { pattern: "x" }, "g1"), pre("Read", f.readInput, "r1"), post("Read", f.readInput, "r1")]);
    expect(view.companion.state).toBe("sniffs");
    expect(view.trainer.state).toBe("notebook");
  });

  it("never gets stuck: a new turn or an unknown result clears the bookkeeping", () => {
    const store = new SessionStore();
    run([pre("Bash", f.bashInput, "b1"), pre("Read", f.readInput, "r1")], store);
    expect(run([f.stop(), f.userPrompt()], store).fetching).toBe(0);
    run([pre("Grep", { pattern: "x" }, "g2")], store);
    expect(run([post("Grep", { pattern: "x" }, "unknown")], store).companion.state).toBe("idle");
  });
});

describe("other hosts", () => {
  const ev = (raw: Record<string, unknown>, platform: "codex" | "copilot") => sanitize(raw, platform)!;
  const base = { session_id: "s", cwd: "/p" };

  it("translates Copilot CLI tool names into their Claude Code equivalents", () => {
    const cases: [string, string][] = [["view", "Read"], ["bash", "Bash"], ["edit", "Edit"], ["create", "Write"], ["grep", "Grep"], ["rg", "Grep"], ["glob", "Glob"], ["web_fetch", "WebFetch"], ["web_search", "WebSearch"], ["task", "Agent"], ["update_todo", "TodoWrite"]];
    for (const [copilot, claude] of cases) {
      expect(ev({ ...base, hook_event_name: "PreToolUse", tool_name: copilot, tool_input: {} }, "copilot").tool).toBe(claude);
    }
    // Copilot's view/edit use `path`: the bubble still shows the file name (never the path).
    expect(ev({ ...base, hook_event_name: "PreToolUse", tool_name: "view", tool_input: { path: "/p/src/app.ts" } }, "copilot").detail).toBe("app.ts");
  });

  it("translates Codex tool names; unknown ones (MCP) pass through", () => {
    expect(ev({ ...base, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: {} }, "codex").tool).toBe("Edit");
    expect(ev({ ...base, hook_event_name: "PreToolUse", tool_name: "update_plan", tool_input: {} }, "codex").tool).toBe("TodoWrite");
    expect(ev({ ...base, hook_event_name: "PreToolUse", tool_name: "mcp__fs__read", tool_input: {} }, "codex").tool).toBe("mcp__fs__read");
    expect(ev({ ...base, hook_event_name: "PreToolUse", tool_name: "view", tool_input: {} }, "codex").tool).toBe("view"); // aliases are per host
  });

  it("Codex Interrupt ends the turn without celebrating; Copilot ErrorOccurred makes the dog sad", () => {
    const store = new SessionStore();
    for (const raw of [{ ...base, hook_event_name: "UserPromptSubmit", prompt: "x" }, { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } }, { ...base, hook_event_name: "Interrupt" }]) {
      store.apply(ev(raw, "codex"), 1000);
    }
    const view = store.view("s")!;
    expect(view.platform).toBe("codex");
    expect(view.companion.state).toBe("idle");
    expect(view.bucket).toBe("done");
    const copilot = new SessionStore();
    copilot.apply(ev({ ...base, hook_event_name: "ErrorOccurred", error: { message: "x" } }, "copilot"), 1000);
    expect(copilot.view("s")!.companion.state).toBe("sad");
  });
});
