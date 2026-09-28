import { createHash } from "node:crypto";
import { PLATFORMS, SPAWN_TOOLS, TOOL_ALIASES, type Platform } from "./table.js";

/**
 * Privacy boundary: turns a raw hook payload into a minimal event. Everything
 * not listed here (tool_response, transcript_path, file contents, prompts,
 * last_assistant_message…) is dropped at this point and never reaches the
 * state, the WebSocket or the disk.
 */

export interface NormalizedEvent {
  /** Which host sent it (Claude Code, Codex, Copilot CLI). */
  platform: Platform;
  event: string;
  sessionId: string;
  /** Present when the hook fires inside a subagent. */
  agentId: string | null;
  agentType: string | null;
  /** Kept only in server memory (scene and project name). */
  cwd: string | null;
  tool: string | null;
  toolUseId: string | null;
  /** Bubble text (≤ DETAIL_MAX characters). */
  detail: string | null;
  /** Agent/Task PreToolUse: data to name the puppy. */
  spawn: { subagentType: string | null; description: string | null } | null;
  /** Agent/Task PostToolUse: agentId of the launched subagent, if present. */
  spawnedAgentId: string | null;
  notificationType: string | null;
  /** SessionStart: startup | resume | clear | compact | fork. */
  source: string | null;
  isInterrupt: boolean;
  /** Tasks completed in this event, as hashes (never the text). */
  completedTaskKeys: string[];
}

export const DETAIL_MAX = 40;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown, re?: RegExp): string | null {
  if (typeof v !== "string" || v === "") return null;
  if (re && !re.test(v)) return null;
  return v;
}

export function truncate(text: string, max = DETAIL_MAX): string {
  // No control characters; a single line.
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
}

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function hashKey(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

/** Short bubble text from tool_input. */
export function toolDetail(tool: string, input: unknown): string | null {
  if (!isObj(input)) return null;
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  let text: string | null = null;
  switch (tool) {
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit": {
      const p = s("file_path") ?? s("path");
      text = p ? basename(p) : null;
      break;
    }
    case "NotebookEdit": {
      const p = s("notebook_path");
      text = p ? basename(p) : null;
      break;
    }
    case "Grep":
    case "Glob":
      text = s("pattern");
      break;
    case "Bash":
    case "PowerShell": {
      const c = s("command");
      text = c ? firstLine(c) : null;
      break;
    }
    case "WebFetch": {
      const u = s("url");
      text = u ? hostname(u) : null;
      break;
    }
    case "WebSearch":
      text = s("query");
      break;
    default:
      if (SPAWN_TOOLS.includes(tool)) text = s("description");
  }
  return text ? truncate(text) : null;
}

function completedTaskKeys(event: string, tool: string | null, raw: Obj): string[] {
  if (event === "TaskCompleted") {
    const id = str(raw.task_id);
    return id ? [hashKey("t", id)] : [];
  }
  if (event !== "PostToolUse" || !isObj(raw.tool_input)) return [];
  const input = raw.tool_input;
  if (tool === "TaskUpdate" && input.status === "completed") {
    const id = str(input.taskId) ?? str(input.task_id) ?? str(input.id);
    return id ? [hashKey("t", id)] : [];
  }
  if (tool === "TodoWrite" && Array.isArray(input.todos)) {
    return input.todos
      .filter((t): t is Obj => isObj(t) && t.status === "completed" && typeof t.content === "string")
      .map((t) => hashKey("todo", t.content as string));
  }
  return [];
}

/** The platform a forwarder says it is, or Claude Code if it says nothing (or something unknown). */
export function toPlatform(value: unknown): Platform {
  return PLATFORMS.includes(value as Platform) ? (value as Platform) : "claude";
}

/** Returns null if the payload is not a valid hook event. */
export function sanitize(raw: unknown, platform: Platform = "claude"): NormalizedEvent | null {
  if (!isObj(raw)) return null;
  const event = str(raw.hook_event_name, /^[A-Za-z]{1,64}$/);
  const sessionId = str(raw.session_id, SESSION_ID_RE);
  if (!event || !sessionId) return null;

  const rawTool = str(raw.tool_name, /^[A-Za-z0-9_.:-]{1,128}$/);
  // Other hosts' tool names, translated to the Claude Code tool with the same meaning.
  const tool = rawTool && (TOOL_ALIASES[platform][rawTool] ?? rawTool);
  const spawnTool = tool !== null && SPAWN_TOOLS.includes(tool);
  const input = isObj(raw.tool_input) ? raw.tool_input : null;
  const response = isObj(raw.tool_response) ? raw.tool_response : null;

  return {
    platform,
    event,
    sessionId,
    agentId: str(raw.agent_id, ID_RE),
    agentType: str(raw.agent_type) ? truncate(raw.agent_type as string, 64) : null,
    cwd: str(raw.cwd),
    tool,
    toolUseId: str(raw.tool_use_id, ID_RE),
    detail: tool ? toolDetail(tool, input) : null,
    spawn:
      spawnTool && event === "PreToolUse"
        ? {
            subagentType: input && typeof input.subagent_type === "string" ? truncate(input.subagent_type, 64) : null,
            description: input && typeof input.description === "string" ? truncate(input.description) : null,
          }
        : null,
    spawnedAgentId: spawnTool && event === "PostToolUse" && response ? str(response.agentId, ID_RE) : null,
    notificationType: str(raw.notification_type, /^[a-z_]{1,64}$/),
    source: str(raw.source, /^[a-z_]{1,32}$/),
    isInterrupt: raw.is_interrupt === true,
    completedTaskKeys: completedTaskKeys(event, tool, raw),
  };
}
