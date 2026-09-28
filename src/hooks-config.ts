import { fileURLToPath } from "node:url";
import type { Platform } from "./mapping/table.js";

/**
 * Events zoomies listens to, named as in the official docs
 * (https://code.claude.com/docs/en/hooks). Record mode captures all of them;
 * the installer only registers the ones the mapper uses.
 */
export const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "TaskCreated",
  "TaskCompleted",
  "CwdChanged",
] as const;

/**
 * Events installed by `zoomies install-hooks`: the ones the mapper uses
 * (src/mapping/table.ts and src/state/store.ts). The recording snippet
 * (hooks-snippet) also includes PostCompact, TaskCreated and CwdChanged to
 * discover payloads.
 */
export const INSTALL_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "TaskCompleted",
] as const;

/**
 * Events installed per host. Codex and Copilot CLI use the same event names
 * as Claude Code (Copilot only when configured with the PascalCase names,
 * which is what makes its payloads Claude-shaped).
 */
export const PLATFORM_EVENTS: Record<Platform, readonly string[]> = {
  claude: INSTALL_EVENTS,
  codex: ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "SubagentStart", "SubagentStop", "PreCompact", "Stop", "Interrupt"],
  copilot: ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "SubagentStop", "PreCompact", "Stop", "ErrorOccurred"],
};

/** Human name of each host. */
export const PLATFORM_NAMES: Record<Platform, string> = { claude: "Claude Code", codex: "Codex", copilot: "GitHub Copilot CLI" };

/** Absolute path of this checkout's forwarder. */
export function forwarderPath(): string {
  return fileURLToPath(new URL("../bin/zoomies-hook.cjs", import.meta.url));
}

/** Hook command: node + forwarder path (no matcher = all), plus `--source` for hosts other than Claude Code. */
export function hookCommand(path = forwarderPath(), platform: Platform = "claude"): string {
  return `node ${JSON.stringify(path)}` + (platform === "claude" ? "" : ` --source ${platform}`);
}

/**
 * Copilot CLI hook file (`.github/hooks/zoomies.json` or `~/.copilot/hooks/`).
 * Copilot denies a tool when a `preToolUse` command fails, so the commands
 * swallow any failure (e.g. a teammate without this checkout): they always
 * exit 0 and print nothing.
 */
export function copilotHooksFile(path = forwarderPath()): { version: 1; hooks: Record<string, unknown[]> } {
  const command = hookCommand(path, "copilot");
  const hooks: Record<string, unknown[]> = {};
  for (const event of PLATFORM_EVENTS.copilot) {
    hooks[event] = [{ type: "command", bash: `${command} || true`, powershell: `${command}; exit 0`, timeoutSec: 2 }];
  }
  return { version: 1, hooks };
}

/** "hooks" block ready to paste into a settings.json. */
export function hooksSnippet(path = forwarderPath()): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    // timeout in seconds: the forwarder already gives up after 1 s.
    hooks[event] = [{ hooks: [{ type: "command", command: hookCommand(path), timeout: 2 }] }];
  }
  return { hooks };
}
