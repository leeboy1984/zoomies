#!/usr/bin/env node
// Generates examples/demo.jsonl: a SYNTHETIC (hand-written) recording in the
// `zoomies serve --record` format, to develop the frontend without real
// sessions. The payloads follow the official hooks docs; still to be checked
// against real recordings.
//
// Two sessions in parallel that go through every state:
//   A (kennel-app): reads, two puppies (Explore and Plan), a permission,
//     a failure, compaction, completed tasks (agility), Stop, sleep and exit.
//   B (blog): WebFetch, its own subagent, an Esc interrupt, Stop.
//
// Usage: node examples/make-demo.mjs > examples/demo.jsonl

const T0 = Date.UTC(2026, 8, 26, 10, 0, 0);
const lines = [];
let tu = 0;

function session(id, cwd) {
  let t = T0;
  const emit = (dt, hook_event_name, extra = {}) => {
    t += dt;
    lines.push({
      v: 1,
      receivedAt: t,
      sentAt: t - 3,
      payload: {
        session_id: id,
        transcript_path: `/home/demo/.claude/projects/${cwd.replaceAll("/", "-")}/${id}.jsonl`,
        cwd,
        permission_mode: "default",
        hook_event_name,
        ...extra,
      },
    });
  };
  const tool = (dt, tool_name, tool_input, { agent, dur = 800, fail, interrupt, response = {} } = {}) => {
    const tool_use_id = `toolu_demo_${String(++tu).padStart(4, "0")}`;
    const who = agent ? { agent_id: agent.id, agent_type: agent.type } : {};
    emit(dt, "PreToolUse", { tool_name, tool_input, tool_use_id, ...who });
    if (fail || interrupt) {
      emit(dur, "PostToolUseFailure", {
        tool_name,
        tool_input,
        tool_use_id,
        error: interrupt ? "Interrupted by user" : "Exit code 1\n2 tests failed",
        is_interrupt: Boolean(interrupt),
        duration_ms: dur,
        ...who,
      });
    } else {
      emit(dur, "PostToolUse", { tool_name, tool_input, tool_response: response, tool_use_id, duration_ms: dur, ...who });
    }
    return tool_use_id;
  };
  return { emit, tool, at: (ms) => (t = T0 + ms) };
}

// ---- Session A -------------------------------------------------------------
{
  const A = session("demo-aaaa-0001", "/home/demo/projects/kennel-app");
  const src = (f) => ({ file_path: `/home/demo/projects/kennel-app/src/${f}` });
  A.emit(0, "SessionStart", { source: "startup", model: "claude-sonnet-5" });
  A.emit(2000, "UserPromptSubmit", { prompt: "Fix the login and add tests" });
  A.tool(1200, "Read", src("auth/login.ts"), { dur: 900 });
  A.tool(600, "Grep", { pattern: "createSession", path: "src" }, { dur: 1200 });
  A.tool(500, "Glob", { pattern: "src/**/*.test.ts" }, { dur: 700 });
  for (const [i, subject] of ["Fix login", "Add tests", "Update docs"].entries()) {
    A.tool(300, "TaskCreate", { subject, description: subject }, { dur: 200, response: { task: { id: String(i + 1) } } });
  }

  // Two puppies
  const explore = { id: "agent-demo-e1", type: "Explore" };
  const plan = { id: "agent-demo-p1", type: "Plan" };
  const agentInput = (subagent_type, description) => ({ subagent_type, description, prompt: "(subagent prompt)" });
  const e1 = "toolu_demo_spawn_e1";
  A.emit(800, "PreToolUse", { tool_name: "Agent", tool_input: agentInput("Explore", "Find login usages"), tool_use_id: e1 });
  A.emit(300, "SubagentStart", { agent_id: explore.id, agent_type: explore.type });
  A.emit(200, "PostToolUse", { tool_name: "Agent", tool_input: agentInput("Explore", "Find login usages"), tool_response: { agentId: explore.id, status: "async_launched" }, tool_use_id: e1 });
  const p1 = "toolu_demo_spawn_p1";
  A.emit(600, "PreToolUse", { tool_name: "Agent", tool_input: agentInput("Plan", "Design the sessions API"), tool_use_id: p1 });
  A.emit(300, "SubagentStart", { agent_id: plan.id, agent_type: plan.type });
  A.emit(200, "PostToolUse", { tool_name: "Agent", tool_input: agentInput("Plan", "Design the sessions API"), tool_response: { agentId: plan.id, status: "async_launched" }, tool_use_id: p1 });
  A.tool(400, "Grep", { pattern: "login\\(" }, { agent: explore, dur: 1500 });
  A.tool(300, "Read", src("routes/auth.ts"), { agent: plan, dur: 1000 });
  A.tool(400, "Read", src("middleware/session.ts"), { agent: explore, dur: 1100 });
  A.tool(500, "WebSearch", { query: "express session cookie sameSite" }, { agent: plan, dur: 2500 });
  A.tool(300, "Glob", { pattern: "**/*session*" }, { agent: explore, dur: 800 });

  // Permission for the main agent, then it fails
  const bash = { command: "npm test -- auth", description: "Run auth tests" };
  const b1 = "toolu_demo_bash_1";
  A.emit(700, "PreToolUse", { tool_name: "Bash", tool_input: bash, tool_use_id: b1 });
  A.emit(100, "PermissionRequest", { tool_name: "Bash", tool_input: bash });
  A.emit(6000, "Notification", { message: "Claude needs your permission to use Bash", title: "Permission needed", notification_type: "permission_prompt" });
  A.emit(2500, "PostToolUseFailure", { tool_name: "Bash", tool_input: bash, tool_use_id: b1, error: "Exit code 1\n2 tests failed", is_interrupt: false, duration_ms: 2400 });

  A.emit(800, "SubagentStop", { stop_hook_active: false, agent_id: explore.id, agent_type: explore.type, agent_transcript_path: "(…)/agent-demo-e1.jsonl", last_assistant_message: "(summary)" });
  A.tool(900, "Read", src("auth/session.ts"), { agent: plan, dur: 900 });
  A.emit(700, "SubagentStop", { stop_hook_active: false, agent_id: plan.id, agent_type: plan.type, agent_transcript_path: "(…)/agent-demo-p1.jsonl", last_assistant_message: "(summary)" });

  // Fix and completed tasks (agility)
  A.tool(1000, "Edit", { ...src("auth/login.ts"), old_string: "(…)", new_string: "(…)" }, { dur: 600 });
  A.tool(400, "TaskUpdate", { taskId: "1", status: "completed" }, { dur: 150 });
  A.emit(10, "TaskCompleted", { task_id: "1", task_subject: "Fix login" });
  A.tool(900, "Write", { ...src("auth/login.test.ts"), content: "(…)" }, { dur: 500 });
  A.tool(700, "Bash", bash, { dur: 3000 });
  A.tool(400, "TaskUpdate", { taskId: "2", status: "completed" }, { dur: 150 });
  A.emit(10, "TaskCompleted", { task_id: "2", task_subject: "Add tests" });

  // Compaction
  A.emit(1200, "PreCompact", { trigger: "auto", custom_instructions: null });
  A.emit(4000, "SessionStart", { source: "compact" });

  A.tool(800, "MultiEdit", { ...src("../README.md"), edits: [] }, { dur: 700 });
  A.tool(400, "TaskUpdate", { taskId: "3", status: "completed" }, { dur: 150 });
  A.emit(10, "TaskCompleted", { task_id: "3", task_subject: "Update docs" });
  A.emit(1500, "Stop", { stop_hook_active: false, last_assistant_message: "(final answer)", background_tasks: [], session_crons: [] });

  // No activity for > 60 s: the UI should put the dog to sleep.
  A.emit(62000, "Notification", { message: "Claude is waiting for your input", notification_type: "idle_prompt" });
  A.emit(8000, "SessionEnd", { reason: "prompt_input_exit" });
}

// ---- Session B -------------------------------------------------------------
{
  const B = session("demo-bbbb-0002", "/home/demo/projects/blog");
  B.at(5000);
  B.emit(0, "SessionStart", { source: "startup" });
  B.emit(1500, "UserPromptSubmit", { prompt: "Review the new post" });
  B.tool(1000, "Read", { file_path: "/home/demo/projects/blog/posts/dogs.md" }, { dur: 600 });
  B.tool(800, "WebFetch", { url: "https://example.com/style-guide", prompt: "(…)" }, { dur: 3000 });
  const rev = { id: "agent-demo-r1", type: "security-reviewer" };
  const r1 = "toolu_demo_spawn_r1";
  const revInput = { subagent_type: rev.type, description: "Check external links", prompt: "(…)" };
  B.emit(700, "PreToolUse", { tool_name: "Agent", tool_input: revInput, tool_use_id: r1 });
  B.emit(300, "SubagentStart", { agent_id: rev.id, agent_type: rev.type });
  B.tool(400, "Grep", { pattern: "https?://" }, { agent: rev, dur: 900 });
  B.tool(300, "Bash", { command: "npx markdown-link-check posts/dogs.md" }, { agent: rev, dur: 5000 });
  B.emit(500, "SubagentStop", { stop_hook_active: false, agent_id: rev.id, agent_type: rev.type, agent_transcript_path: "(…)", last_assistant_message: "(…)" });
  B.emit(100, "PostToolUse", { tool_name: "Agent", tool_input: revInput, tool_response: { content: [] }, tool_use_id: r1 });
  B.tool(900, "Bash", { command: "npm run build" }, { dur: 4000, interrupt: true });
  B.emit(1500, "UserPromptSubmit", { prompt: "Just the lint, please" });
  B.tool(800, "Bash", { command: "npm run lint" }, { dur: 2000 });
  B.emit(1000, "Stop", { stop_hook_active: false, last_assistant_message: "(…)", background_tasks: [], session_crons: [] });
}

lines.sort((a, b) => a.receivedAt - b.receivedAt);
process.stdout.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
