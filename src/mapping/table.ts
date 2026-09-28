/**
 * Event → state mapping table. Data only: tweaking the behaviour does not
 * require touching the logic (src/state/store.ts).
 *
 * Event and tool names follow https://code.claude.com/docs/en/hooks and
 * https://code.claude.com/docs/en/tools-reference. Still to be confirmed
 * against real payloads (docs/record-mode.md).
 */

export const TRAINER_STATES = ["enters", "idle", "notebook", "stopwatch", "whistles", "points", "celebrates", "leaves"] as const;
export type TrainerState = (typeof TRAINER_STATES)[number];

export const DOG_STATES = [
  "arrives",
  "alert",
  "reads",
  "sniffs",
  "digs",
  "runs",
  "fetches",
  "agility",
  "idle",
  "sad",
  "asks",
  "shakes",
  "celebrates",
  "sleeps",
  "leaves",
] as const;
export type DogState = (typeof DOG_STATES)[number];

/** Puppies use the dog states plus these two. */
export const PUPPY_STATES = [...DOG_STATES, "dashes_off", "returns"] as const;
export type PuppyState = (typeof PUPPY_STATES)[number];

/**
 * Dog animations that are not states: the UI picks them from the terrain
 * (pees next to lamp posts, trees and bins; jumps over hurdles and the hoop).
 */
export const DOG_TERRAIN_ANIMS = ["pees", "jumps"] as const;

/** Trainer animations that are not states (the UI picks them): at the bar and when throwing. */
export const TRAINER_UI_ANIMS = ["sits", "drinks", "stands", "stands_drinking", "winds_up", "throws"] as const;

/** States decided by the UI (over time), not by the server. */
export const UI_ONLY_STATES: readonly DogState[] = ["sleeps"];

/** With no events for this long, the UI switches the dog to `sleeps`. */
export const SLEEP_AFTER_MS = 60_000;

/** Dog state (companion or puppy) when a tool starts. */
export const DOG_TOOL_STATES: Record<string, DogState> = {
  Read: "reads",
  Grep: "sniffs",
  Glob: "sniffs",
  Edit: "digs",
  Write: "digs",
  MultiEdit: "digs",
  NotebookEdit: "digs",
  Bash: "runs",
  PowerShell: "runs",
  WebFetch: "fetches",
  WebSearch: "fetches",
  TodoWrite: "agility",
  TaskCreate: "agility",
  TaskUpdate: "agility",
  TaskList: "agility",
  TaskGet: "agility",
};

/** Tool with no entry in DOG_TOOL_STATES (MCP, Agent, etc.). */
export const DOG_TOOL_DEFAULT: DogState = "alert";

/** Dog state per event (tool events are handled separately). */
export const DOG_EVENT_STATES: Record<string, DogState> = {
  SessionStart: "arrives",
  UserPromptSubmit: "alert",
  PostToolUse: "idle",
  PostToolUseFailure: "sad",
  PermissionRequest: "asks",
  PermissionDenied: "sad",
  PreCompact: "shakes",
  Stop: "celebrates",
  StopFailure: "sad",
  SessionEnd: "leaves",
  // Codex: the person interrupted the turn.
  Interrupt: "idle",
  // Copilot: an error outside a tool (model call, system…).
  ErrorOccurred: "sad",
};

/** A failure caused by the user interrupting (Esc) is not the dog's failure. */
export const DOG_INTERRUPTED_STATE: DogState = "idle";

/** Notification types that count as a permission request. */
export const PERMISSION_NOTIFICATION_TYPES = ["permission_prompt"];

/** Trainer (only reacts to the main agent, except for `points`). */
export const TRAINER_TOOL_STATES: Record<string, TrainerState> = {
  Read: "notebook",
  Edit: "notebook",
  Write: "notebook",
  MultiEdit: "notebook",
  NotebookEdit: "notebook",
  Grep: "notebook",
  Glob: "notebook",
  Bash: "stopwatch",
  PowerShell: "stopwatch",
  // The subagent tool is called Agent; older versions call it Task.
  Agent: "whistles",
  Task: "whistles",
};

export const TRAINER_TOOL_DEFAULT: TrainerState = "idle";

export const TRAINER_EVENT_STATES: Record<string, TrainerState> = {
  SessionStart: "enters",
  UserPromptSubmit: "idle",
  PostToolUse: "idle",
  PostToolUseFailure: "idle",
  PermissionRequest: "points",
  PermissionDenied: "idle",
  Stop: "celebrates",
  StopFailure: "idle",
  SessionEnd: "leaves",
  Interrupt: "idle",
  ErrorOccurred: "idle",
};

/** Events that end the current turn. */
export const TURN_END_EVENTS = ["Stop", "StopFailure", "Interrupt"];

/** Tools that launch subagents. */
export const SPAWN_TOOLS = ["Agent", "Task"];

/** Puppies. */
export const PUPPY_EVENT_STATES: Record<string, PuppyState> = {
  SubagentStart: "dashes_off",
  SubagentStop: "returns",
};

/** Breeds = distinct silhouettes (art/sprites/dog-<breed>.txt). */
export const BREEDS = ["dachshund", "beagle", "border_collie", "pug", "mutt"] as const;
export type Breed = (typeof BREEDS)[number];

/** Coats of each breed (variants in art/variants.json); the sprite is `dog.<breed>.<coat>`. */
export const BREED_COATS: Record<Breed, readonly string[]> = {
  dachshund: ["red", "black_tan", "chocolate", "cream", "blue_tan", "wild_boar"],
  beagle: ["tricolor", "lemon"],
  border_collie: ["black", "red", "merle"],
  pug: ["fawn", "black"],
  mutt: ["cinnamon", "golden", "grey", "cream"],
};

/** Trainers: style (silhouette and clothes) × skin tone; sprite `trainer.<style>.<skin>`. */
export const TRAINER_STYLES = ["cap", "beanie", "long_hair", "hat", "ponytail"] as const;
export const TRAINER_SKINS = ["light", "medium", "brown", "dark"] as const;
export type TrainerStyle = (typeof TRAINER_STYLES)[number];
export type TrainerSkin = (typeof TRAINER_SKINS)[number];

/** Puppy breed per agent_type. */
export const BREEDS_BY_AGENT_TYPE: Record<string, Breed> = {
  Explore: "beagle",
  Plan: "border_collie",
  "general-purpose": "mutt",
};

/** For an agent_type without its own breed, one of these is picked by hashing the agent_type. */
export const OTHER_BREEDS: readonly Breed[] = ["pug", "dachshund", "mutt"];

/**
 * Hosts zoomies can listen to. Codex and Copilot CLI send the same payload
 * shape as Claude Code (Copilot when its hooks use the PascalCase event names),
 * so the only difference is the tool names; the forwarder says which host it is
 * with `--source <platform>`.
 */
export const PLATFORMS = ["claude", "codex", "copilot"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Tool names of other hosts → the Claude Code tool with the same meaning (the tables above use those). */
export const TOOL_ALIASES: Record<Platform, Record<string, string>> = {
  claude: {},
  codex: {
    shell: "Bash",
    apply_patch: "Edit",
    update_plan: "TodoWrite",
    spawn_agent: "Agent",
    web_search: "WebSearch",
  },
  copilot: {
    bash: "Bash",
    powershell: "PowerShell",
    view: "Read",
    create: "Write",
    edit: "Edit",
    str_replace_editor: "Edit",
    apply_patch: "Edit",
    glob: "Glob",
    grep: "Grep",
    rg: "Grep",
    web_fetch: "WebFetch",
    web_search: "WebSearch",
    task: "Agent",
    update_todo: "TodoWrite",
  },
};

export const SCENARIOS = ["park", "forest", "agility", "beach", "square", "snow"] as const;
export type Scenario = (typeof SCENARIOS)[number];

/**
 * Without config, the scene comes from hashing the cwd among these.
 * `agility` is reserved for config (or for sessions that complete tasks).
 */
export const HASH_SCENARIOS: readonly Scenario[] = ["park", "forest", "beach", "square", "snow"];
