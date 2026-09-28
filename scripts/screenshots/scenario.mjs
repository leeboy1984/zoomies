// The recording behind the README screenshots: fourteen sessions spread across
// the park, each doing something worth looking at (fetch, sniffing, peeing,
// laps, reading, a permission request, puppies, agility) plus four that finish
// early so they can end up at the bar. `dashboard` runs on Codex and `docs` on
// GitHub Copilot CLI (with Copilot's own tool names), to show their badges.

const T0 = Date.UTC(2026, 8, 28, 10, 0, 0);
const END = 60_000;

export function buildScenario() {
  const lines = [];
  let n = 0;
  const PLATFORM = { dashboard: "codex", docs: "copilot" };
  const session = (name, sid) => {
    const source = PLATFORM[name];
    const base = {
      session_id: sid,
      transcript_path: `/home/dev/.claude/projects/-home-dev-projects-${name}/${sid}.jsonl`,
      cwd: `/home/dev/projects/${name}`,
      permission_mode: "default",
    };
    const ev = (t, payload) => lines.push({ v: 1, receivedAt: T0 + t, sentAt: T0 + t - 3, ...(source ? { source } : {}), payload: { ...base, ...payload } });
    const tool = (t, dur, tool_name, tool_input, extra = {}, end = true) => {
      const tool_use_id = `toolu_shot_${String(++n).padStart(3, "0")}`;
      ev(t, { hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id, ...extra });
      if (end) ev(t + dur, { hook_event_name: "PostToolUse", tool_name, tool_input, tool_response: {}, tool_use_id, duration_ms: dur, ...extra });
    };
    return { ev, tool };
  };
  const names = ["api", "analytics", "backend", "dashboard", "blog", "payments", "shop", "docs", "mobile-app", "website", "inventory", "weather", "crm", "notes"];
  const S = {};
  names.forEach((name, i) => {
    S[name] = session(name, `shot-${String(i).padStart(2, "0")}-${name}`);
    S[name].ev(i * 300, { hook_event_name: "SessionStart", source: "startup", model: "claude-sonnet-5" });
    S[name].ev(i * 300 + 1500, { hook_event_name: "UserPromptSubmit", prompt: "(…)" });
  });
  const src = (project, file) => ({ file_path: `/home/dev/projects/${project}/src/${file}` });

  // park: fetch and peeing by a tree
  S.api.tool(22000, 12000, "WebFetch", { url: "https://docs.example.com/api", prompt: "(…)" });
  S.analytics.tool(8000, END, "Edit", { ...src("analytics", "report.ts"), old_string: "(…)", new_string: "(…)" });
  // forest: sniffing and laps
  S.backend.tool(8000, END, "Grep", { pattern: "createOrder", path: "src" });
  S.dashboard.tool(8000, END, "Bash", { command: "npm run test:e2e", description: "(…)" });
  // snow: peeing by a pine, and two puppies
  S.blog.tool(8000, END, "Write", { ...src("blog", "posts/winter.md"), content: "(…)" });
  for (const [agent_id, agent_type, description, t] of [["agent-shot-e", "Explore", "Find refund flows", 5000], ["agent-shot-p", "Plan", "Plan the webhook retry", 5600]]) {
    const tool_use_id = `toolu_spawn_${agent_id}`;
    const tool_input = { subagent_type: agent_type, description, prompt: "(…)" };
    S.payments.ev(t, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input, tool_use_id });
    S.payments.ev(t + 300, { hook_event_name: "SubagentStart", agent_id, agent_type });
    S.payments.ev(t + 500, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_input, tool_response: { agentId: agent_id, status: "async_launched" }, tool_use_id });
  }
  S.payments.tool(9000, END, "Grep", { pattern: "refund" }, { agent_id: "agent-shot-e", agent_type: "Explore" });
  S.payments.tool(9500, END, "Read", src("payments", "webhooks.ts"), { agent_id: "agent-shot-p", agent_type: "Plan" });
  // square: asking for permission
  S.shop.tool(8000, 0, "Bash", { command: "rm -rf dist && npm run build", description: "(…)" }, {}, false);
  S.shop.ev(8200, { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf dist && npm run build" } });
  // beach: reading, and fetch on the sand
  S.docs.tool(8000, END, "view", { path: "/home/dev/projects/docs/src/guide/getting-started.md" }); // Copilot's name for Read
  S["mobile-app"].tool(27000, 10000, "WebSearch", { query: "react native gesture handler" });
  // agility: completes tasks (moves to agility), then keeps working on tasks
  S.website.ev(3000, { hook_event_name: "TaskCompleted", task_id: "1", task_subject: "(…)" });
  S.website.ev(3100, { hook_event_name: "TaskCompleted", task_id: "2", task_subject: "(…)" });
  S.website.tool(8000, END, "TaskUpdate", { taskId: "3", status: "in_progress" });
  // sessions that finish early (for the bar)
  for (const name of ["inventory", "weather", "crm", "notes"]) {
    S[name].tool(3000, 1500, "Read", src(name, "index.ts"));
    S[name].ev(5500, { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "(…)", background_tasks: [], session_crons: [] });
  }
  lines.sort((a, b) => a.receivedAt - b.receivedAt);
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}
