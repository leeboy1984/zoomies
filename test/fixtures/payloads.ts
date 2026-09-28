/**
 * Example payloads shaped as documented at
 * https://code.claude.com/docs/en/hooks (checked on 2026-09-26).
 *
 * STILL TO VERIFY against real recordings (docs/record-mode.md), especially:
 * agent_id on subagent tool events, tool_response.agentId on
 * PostToolUse(Agent), and the TaskUpdate/TaskCompleted fields.
 */

export const SESSION = "11111111-2222-3333-4444-555555555555";
export const CWD = "/home/dog/projects/my-app";
export const TRANSCRIPT = "/home/dog/.claude/projects/-home-dog-projects-my-app/abc.jsonl";

type P = Record<string, unknown>;

const base = (hook_event_name: string, extra: P = {}): P => ({
  session_id: SESSION,
  transcript_path: TRANSCRIPT,
  cwd: CWD,
  permission_mode: "default",
  hook_event_name,
  ...extra,
});

/** Fields added when the hook fires inside a subagent. */
export const inAgent = (agent_id: string, agent_type: string) => ({ agent_id, agent_type });

export const sessionStart = (source = "startup") => base("SessionStart", { source, model: "claude-sonnet-5" });
export const sessionEnd = (reason = "prompt_input_exit") => base("SessionEnd", { reason });
export const userPrompt = (prompt = "Fix the login test, the password is hunter2") =>
  base("UserPromptSubmit", { prompt });

let n = 0;
export const toolUseId = () => `toolu_${String(++n).padStart(6, "0")}`;

export const preTool = (tool_name: string, tool_input: P, extra: P = {}) =>
  base("PreToolUse", { tool_name, tool_input, tool_use_id: extra.tool_use_id ?? toolUseId(), ...extra });

export const postTool = (tool_name: string, tool_input: P, tool_response: unknown, extra: P = {}) =>
  base("PostToolUse", { tool_name, tool_input, tool_response, tool_use_id: toolUseId(), duration_ms: 12, ...extra });

export const toolFailure = (tool_name: string, tool_input: P, is_interrupt = false, extra: P = {}) =>
  base("PostToolUseFailure", {
    tool_name,
    tool_input,
    tool_use_id: toolUseId(),
    error: "Exit code 1\nError: Cannot find module 'express'",
    is_interrupt,
    duration_ms: 4187,
    ...extra,
  });

/** No tool_use_id, as documented. */
export const permissionRequest = (tool_name: string, tool_input: P, extra: P = {}) =>
  base("PermissionRequest", {
    tool_name,
    tool_input,
    permission_suggestions: [{ type: "addRules", rules: [{ toolName: tool_name }], behavior: "allow" }],
    ...extra,
  });

export const permissionDenied = (tool_name: string, tool_input: P) =>
  base("PermissionDenied", {
    permission_mode: "auto",
    tool_name,
    tool_input,
    tool_use_id: toolUseId(),
    reason: "[Irreversible Local Destruction]",
  });

export const notification = (notification_type: string, extra: P = {}) =>
  base("Notification", { message: "Claude needs your permission", title: "Permission needed", notification_type, ...extra });

export const stop = () =>
  base("Stop", { stop_hook_active: false, last_assistant_message: "I changed src/secret.ts", background_tasks: [], session_crons: [] });

export const stopFailure = () => base("StopFailure", { error: "rate_limit", last_assistant_message: "API Error" });

export const preCompact = (trigger = "auto") => base("PreCompact", { trigger, custom_instructions: null });

export const subagentStart = (agent_id: string, agent_type: string) => base("SubagentStart", { agent_id, agent_type });

export const subagentStop = (agent_id: string, agent_type: string) =>
  base("SubagentStop", {
    stop_hook_active: false,
    agent_id,
    agent_type,
    agent_transcript_path: `${TRANSCRIPT.replace(".jsonl", "")}/subagents/agent-${agent_id}.jsonl`,
    last_assistant_message: "Found 3 problems in src/auth.ts",
  });

export const taskCompleted = (task_id: string, task_subject = "Implement login") =>
  base("TaskCompleted", { task_id, task_subject, task_description: "Login endpoints" });

// Typical tool inputs
export const readInput = { file_path: "/home/dog/projects/my-app/src/auth/login.ts" };
export const writeInput = { file_path: "/home/dog/projects/my-app/src/notes.txt", content: "SECRET CONTENT" };
export const editInput = { file_path: "/home/dog/projects/my-app/src/app.ts", old_string: "SECRET_A", new_string: "SECRET_B" };
export const bashInput = { command: "npm test -- --grep 'login' && echo 'a very long line that keeps going'\nsecond line", description: "Run tests" };
export const agentInput = (subagent_type: string, description: string) => ({
  subagent_type,
  description,
  prompt: "SECRET PROMPT OF THE SUBAGENT",
});
