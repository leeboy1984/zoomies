import { createHash } from "node:crypto";
import { configuredCompanion, configuredScenario, DEFAULT_CONFIG, type ZoomiesConfig } from "../config.js";
import type { NormalizedEvent } from "../mapping/sanitize.js";
import { truncate } from "../mapping/sanitize.js";
import {
  BREED_COATS,
  BREEDS,
  BREEDS_BY_AGENT_TYPE,
  DOG_EVENT_STATES,
  DOG_INTERRUPTED_STATE,
  DOG_TOOL_DEFAULT,
  DOG_TOOL_STATES,
  HASH_SCENARIOS,
  PERMISSION_NOTIFICATION_TYPES,
  OTHER_BREEDS,
  PUPPY_EVENT_STATES,
  SPAWN_TOOLS,
  TURN_END_EVENTS,
  type Platform,
  TRAINER_EVENT_STATES,
  TRAINER_TOOL_DEFAULT,
  TRAINER_TOOL_STATES,
  type Breed,
  type DogState,
  type PuppyState,
  TRAINER_SKINS,
  TRAINER_STYLES,
  type Scenario,
  type TrainerSkin,
  type TrainerState,
  type TrainerStyle,
} from "../mapping/table.js";

/**
 * Per-session state. The server is the source of truth: the UI only draws what
 * it receives (and decides `sleeps` over time).
 */

export interface ActorView<S extends string> {
  state: S;
  /** Epoch ms when the current state started. */
  since: number;
  /** Bubble text. */
  detail: string | null;
  tool: string | null;
  lastEventAt: number;
}

export interface PuppyView extends ActorView<PuppyState> {
  id: string;
  agentType: string | null;
  breed: Breed;
  /** Coat of the breed; the sprite is `dog.<breed>.<coat>`. */
  coat: string;
  name: string | null;
  startedAt: number;
}

export type Bucket = "needs_you" | "working" | "done" | "ended";

export interface SessionView {
  id: string;
  /** The host running the session: Claude Code, Codex or Copilot CLI. */
  platform: Platform;
  /** Only the folder name, never the full path. */
  project: string;
  scenario: Scenario;
  /** Trainer look (sprite `trainer.<style>.<skin>`): same project, same trainer. */
  trainerLook: { style: TrainerStyle; skin: TrainerSkin };
  /** Breed and coat of the companion dog (sprite `dog.<breed>.<coat>`). */
  companionLook: { breed: Breed; coat: string };
  bucket: Bucket;
  trainer: ActorView<TrainerState>;
  companion: ActorView<DogState>;
  puppies: PuppyView[];
  /** Agility obstacles cleared (completed tasks). */
  obstacles: number;
  /** Main-agent searches (WebFetch/WebSearch) running in parallel right now. */
  fetching: number;
  startedAt: number;
  lastEventAt: number;
  endedAt: number | null;
}

export interface StoreOptions {
  /** Session with no events for this long: removed. */
  sessionIdleMs: number;
  /** Ended session: shown for this long before removing it. */
  endedLingerMs: number;
  /** Puppy with no events for this long: considered a zombie and returns. */
  puppyZombieMs: number;
  /** How long the `returns` animation lasts before removing the puppy. */
  puppyLeaveMs: number;
  /** PreToolUse(Agent) without SubagentStart: forgotten after this long. */
  pendingSpawnMs: number;
  maxPuppies: number;
  maxSessions: number;
}

export const DEFAULT_STORE_OPTIONS: StoreOptions = {
  sessionIdleMs: 30 * 60_000,
  endedLingerMs: 2 * 60_000,
  puppyZombieMs: 10 * 60_000,
  puppyLeaveMs: 4_000,
  pendingSpawnMs: 2 * 60_000,
  maxPuppies: 8,
  maxSessions: 64,
};

interface Puppy extends PuppyView {
  leavingAt: number | null;
}

interface PendingSpawn {
  toolUseId: string | null;
  subagentType: string | null;
  description: string | null;
  at: number;
}

interface InFlightTool {
  tool: string | null;
  dog: DogState | null;
  trainer: TrainerState | null;
  detail: string | null;
}

interface Session {
  id: string;
  platform: Platform;
  cwd: string | null;
  scenario: Scenario;
  /** The scene comes from zoomies.config.json (it never switches to agility on its own). */
  scenarioConfigured: boolean;
  trainer: ActorView<TrainerState>;
  companion: ActorView<DogState>;
  puppies: Map<string, Puppy>;
  completed: Set<string>;
  pendingSpawns: PendingSpawn[];
  namesByAgentId: Map<string, string>;
  /** Main-agent tools in progress (by tool_use_id), to handle tools running in parallel. */
  inFlight: Map<string, InFlightTool>;
  turnActive: boolean;
  startedAt: number;
  lastEventAt: number;
  endedAt: number | null;
}

const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"]);

function hashIndex(text: string, n: number): number {
  return createHash("sha256").update(text).digest().readUInt32BE(0) % n;
}

export function scenarioForCwd(cwd: string | null): Scenario {
  if (!cwd) return HASH_SCENARIOS[0] ?? "park";
  return HASH_SCENARIOS[hashIndex(cwd, HASH_SCENARIOS.length)] ?? "park";
}

export function trainerLookFor(key: string): { style: TrainerStyle; skin: TrainerSkin } {
  const h = createHash("sha256").update(key).digest();
  return {
    style: TRAINER_STYLES[(h[0] ?? 0) % TRAINER_STYLES.length] ?? "cap",
    skin: TRAINER_SKINS[(h[1] ?? 0) % TRAINER_SKINS.length] ?? "medium",
  };
}

/**
 * Each project's own dog when the config does not set one: any breed (or the
 * configured one), then any of its coats, so the same project always brings
 * the same dog.
 */
export function companionLookFor(key: string, only?: Breed): { breed: Breed; coat: string } {
  const h = createHash("sha256").update(`dog:${key}`).digest();
  const breed = only ?? BREEDS[(h[0] ?? 0) % BREEDS.length] ?? "dachshund";
  const coats = BREED_COATS[breed];
  return { breed, coat: coats[(h[1] ?? 0) % coats.length] ?? coats[0] ?? "" };
}

function projectName(s: Session): string {
  const base = s.cwd?.split(/[\\/]/).filter(Boolean).pop();
  return base ? truncate(base, 32) : `session ${s.id.slice(0, 8)}`;
}

function actor<S extends string>(state: S, now: number): ActorView<S> {
  return { state, since: now, detail: null, tool: null, lastEventAt: now };
}

function setState<S extends string>(a: ActorView<S>, state: S, now: number, detail: string | null = null, tool: string | null = null): void {
  if (a.state !== state || a.detail !== detail || a.tool !== tool) a.since = now;
  a.state = state;
  a.detail = detail;
  a.tool = tool;
  a.lastEventAt = now;
}

/** Dog state (companion or puppy) for an event; null = no change. */
export function dogStateFor(ev: NormalizedEvent): DogState | null {
  if (ev.event === "PreToolUse") return (ev.tool && DOG_TOOL_STATES[ev.tool]) || DOG_TOOL_DEFAULT;
  if (ev.event === "PostToolUseFailure" && ev.isInterrupt) return DOG_INTERRUPTED_STATE;
  if (ev.event === "Notification") {
    return ev.notificationType && PERMISSION_NOTIFICATION_TYPES.includes(ev.notificationType) ? "asks" : null;
  }
  return DOG_EVENT_STATES[ev.event] ?? null;
}

/** Trainer state for a main-agent event; null = no change. */
export function trainerStateFor(ev: NormalizedEvent): TrainerState | null {
  if (ev.event === "PreToolUse") return (ev.tool && TRAINER_TOOL_STATES[ev.tool]) || TRAINER_TOOL_DEFAULT;
  if (ev.event === "Notification") {
    return ev.notificationType && PERMISSION_NOTIFICATION_TYPES.includes(ev.notificationType) ? "points" : null;
  }
  return TRAINER_EVENT_STATES[ev.event] ?? null;
}

function dogDetail(ev: NormalizedEvent): string | null {
  switch (ev.event) {
    case "PreToolUse":
      return ev.detail ?? ev.tool;
    case "PermissionRequest":
    case "PermissionDenied":
      return ev.tool ? truncate(ev.detail ? `${ev.tool}: ${ev.detail}` : ev.tool) : null;
    case "PostToolUseFailure":
      return ev.tool;
    default:
      return null;
  }
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  readonly opts: StoreOptions;

  constructor(
    opts: Partial<StoreOptions> = {},
    readonly config: ZoomiesConfig = DEFAULT_CONFIG,
  ) {
    this.opts = { ...DEFAULT_STORE_OPTIONS, ...opts };
  }

  /** Applies an event. Returns the id of the modified session. */
  apply(ev: NormalizedEvent, now: number): string {
    const s = this.getOrCreate(ev, now);
    s.lastEventAt = now;
    if (ev.cwd && !s.cwd) {
      s.cwd = ev.cwd;
      const configured = configuredScenario(this.config, ev.cwd);
      s.scenarioConfigured = configured !== null;
      s.scenario = configured ?? scenarioForCwd(ev.cwd);
    }
    for (const key of ev.completedTaskKeys) s.completed.add(key);
    // A session that completes tasks moves to the agility course (unless its scene is configured).
    if (this.config.agilityForTasks && !s.scenarioConfigured && s.completed.size > 0) s.scenario = "agility";
    this.expirePending(s, now);

    switch (ev.event) {
      case "SessionStart":
        return this.onSessionStart(s, ev, now);
      case "SessionEnd":
        return this.onSessionEnd(s, now);
      case "SubagentStart":
        return this.onSubagentStart(s, ev, now);
      case "SubagentStop":
        return this.onSubagentStop(s, ev, now);
    }

    // Any tool activity implies a turn in progress (also in resumed sessions).
    if (ev.event === "UserPromptSubmit" || TOOL_EVENTS.has(ev.event)) s.turnActive = true;
    if (TURN_END_EVENTS.includes(ev.event)) s.turnActive = false;

    // If PermissionRequest already set someone asking, the permission_prompt
    // Notification (arriving ~6 s later) adds nothing.
    if (ev.event === "Notification" && this.anyoneAsking(s)) return s.id;

    const puppy = ev.agentId ? this.puppyFor(s, ev, now) : null;
    if (puppy) {
      const state = dogStateFor(ev);
      if (state) setState<PuppyState>(puppy, state, now, dogDetail(ev), ev.tool);
      else puppy.lastEventAt = now;
      // Only the person can grant a permission: the trainer always points it out.
      if (state === "asks") setState<TrainerState>(s.trainer, "points", now, puppy.detail);
    } else {
      this.onMainAgentEvent(s, ev, now);
    }

    this.settleTrainer(s, now);
    return s.id;
  }

  /** Expires puppies and sessions. Returns changed and removed sessions. */
  sweep(now: number): { changed: string[]; removed: string[] } {
    const changed: string[] = [];
    const removed: string[] = [];
    for (const s of this.sessions.values()) {
      const expired =
        s.endedAt !== null ? now - s.endedAt > this.opts.endedLingerMs : now - s.lastEventAt > this.opts.sessionIdleMs;
      if (expired) {
        this.sessions.delete(s.id);
        removed.push(s.id);
        continue;
      }
      let touched = false;
      for (const p of s.puppies.values()) {
        if (p.leavingAt !== null) {
          if (now - p.leavingAt > this.opts.puppyLeaveMs) {
            s.puppies.delete(p.id);
            touched = true;
          }
        } else if (now - p.lastEventAt > this.opts.puppyZombieMs) {
          setState<PuppyState>(p, "returns", now);
          p.leavingAt = now;
          touched = true;
        }
      }
      if (this.expirePending(s, now)) touched = true;
      if (touched) changed.push(s.id);
    }
    return { changed, removed };
  }

  view(id: string): SessionView | null {
    const s = this.sessions.get(id);
    return s ? this.toView(s) : null;
  }

  snapshot(): SessionView[] {
    return [...this.sessions.values()].map((s) => this.toView(s));
  }

  // ---------------------------------------------------------------------

  private getOrCreate(ev: NormalizedEvent, now: number): Session {
    const existing = this.sessions.get(ev.sessionId);
    if (existing) return existing;
    if (this.sessions.size >= this.opts.maxSessions) this.evictOldest();
    const s: Session = {
      id: ev.sessionId,
      platform: ev.platform,
      cwd: null,
      scenario: scenarioForCwd(null),
      scenarioConfigured: false,
      trainer: actor<TrainerState>("idle", now),
      companion: actor<DogState>("idle", now),
      puppies: new Map(),
      completed: new Set(),
      pendingSpawns: [],
      namesByAgentId: new Map(),
      inFlight: new Map(),
      turnActive: false,
      startedAt: now,
      lastEventAt: now,
      endedAt: null,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  private evictOldest(): void {
    let oldest: Session | null = null;
    for (const s of this.sessions.values()) if (!oldest || s.lastEventAt < oldest.lastEventAt) oldest = s;
    if (oldest) this.sessions.delete(oldest.id);
  }

  private onSessionStart(s: Session, ev: NormalizedEvent, now: number): string {
    // After a compaction Claude Code fires SessionStart again: it is not an arrival.
    if (ev.source === "compact") {
      if (s.companion.state === "shakes") setState<DogState>(s.companion, "idle", now);
      return s.id;
    }
    s.endedAt = null;
    setState<DogState>(s.companion, "arrives", now);
    setState<TrainerState>(s.trainer, "enters", now);
    return s.id;
  }

  private onSessionEnd(s: Session, now: number): string {
    s.endedAt = now;
    s.turnActive = false;
    setState<DogState>(s.companion, "leaves", now);
    setState<TrainerState>(s.trainer, "leaves", now);
    for (const p of s.puppies.values()) {
      if (p.leavingAt === null) {
        setState<PuppyState>(p, "returns", now);
        p.leavingAt = now;
      }
    }
    return s.id;
  }

  private onSubagentStart(s: Session, ev: NormalizedEvent, now: number): string {
    if (!ev.agentId) return s.id;
    const existing = s.puppies.get(ev.agentId);
    const state = PUPPY_EVENT_STATES.SubagentStart ?? "dashes_off";
    if (existing) {
      existing.leavingAt = null;
      setState<PuppyState>(existing, state, now);
      return s.id;
    }
    const puppy = this.createPuppy(s, ev.agentId, ev.agentType, now);
    if (puppy) setState<PuppyState>(puppy, state, now);
    return s.id;
  }

  private onSubagentStop(s: Session, ev: NormalizedEvent, now: number): string {
    // Claude Code also fires SubagentStop for internal agents that never had a
    // SubagentStart: if we do not know it, it is ignored.
    const p = ev.agentId ? s.puppies.get(ev.agentId) : undefined;
    if (p) {
      setState<PuppyState>(p, PUPPY_EVENT_STATES.SubagentStop ?? "returns", now);
      p.leavingAt = now;
    }
    return s.id;
  }

  /** Puppy to attribute an agent_id event to; creates a "ghost" one if needed. */
  private puppyFor(s: Session, ev: NormalizedEvent, now: number): Puppy | null {
    const id = ev.agentId;
    if (!id) return null;
    const known = s.puppies.get(id);
    if (known) return known;
    if (!TOOL_EVENTS.has(ev.event)) return null;
    // Activity from a subagent whose SubagentStart we missed (server restarted).
    return this.createPuppy(s, id, ev.agentType, now);
  }

  private createPuppy(s: Session, id: string, agentType: string | null, now: number): Puppy | null {
    if (s.puppies.size >= this.opts.maxPuppies) return null;
    const breed: Breed =
      (agentType && BREEDS_BY_AGENT_TYPE[agentType]) || OTHER_BREEDS[hashIndex(agentType ?? id, OTHER_BREEDS.length)] || "mutt";
    const coats = BREED_COATS[breed];
    const puppy: Puppy = {
      id,
      agentType,
      breed,
      // Several puppies of the same type: same dog, different coat.
      coat: coats[hashIndex(id, coats.length)] ?? coats[0] ?? "",
      name: this.takeName(s, id, agentType),
      startedAt: now,
      ...actor<PuppyState>("dashes_off", now),
      leavingAt: null,
    };
    s.puppies.set(id, puppy);
    return puppy;
  }

  /** Puppy name: by exact agentId or, failing that, the oldest pending PreToolUse(Agent) of its type. */
  private takeName(s: Session, agentId: string, agentType: string | null): string | null {
    const exact = s.namesByAgentId.get(agentId);
    if (exact) return exact;
    const idx = s.pendingSpawns.findIndex((p) => p.subagentType === agentType);
    const pick = idx >= 0 ? idx : s.pendingSpawns.findIndex((p) => p.subagentType === null);
    if (pick < 0) return null;
    const [spawn] = s.pendingSpawns.splice(pick, 1);
    return spawn?.description ?? null;
  }

  private onMainAgentEvent(s: Session, ev: NormalizedEvent, now: number): void {
    const isSpawn = ev.tool !== null && SPAWN_TOOLS.includes(ev.tool);
    if (isSpawn && ev.event === "PreToolUse" && ev.spawn) {
      s.pendingSpawns.push({ toolUseId: ev.toolUseId, ...ev.spawn, at: now });
    }
    if (isSpawn && ev.event === "PostToolUse") this.linkSpawn(s, ev);

    if (this.trackInFlight(s, ev, now)) return;

    const dog = dogStateFor(ev);
    if (dog) setState(s.companion, dog, now, dogDetail(ev), ev.tool);
    else s.companion.lastEventAt = now;

    const trainer = trainerStateFor(ev);
    if (trainer) setState(s.trainer, trainer, now, trainer === "points" ? s.companion.detail : null, ev.tool);
  }

  /**
   * Tools running in parallel: when one finishes while others are still in
   * progress, the dog and trainer go back to the most recent one still running
   * instead of resting. Returns true if the event has already been applied.
   */
  private trackInFlight(s: Session, ev: NormalizedEvent, now: number): boolean {
    if (["UserPromptSubmit", "SessionStart", "SessionEnd", ...TURN_END_EVENTS].includes(ev.event)) {
      s.inFlight.clear();
      return false;
    }
    if (ev.event === "PreToolUse" && ev.toolUseId) {
      s.inFlight.set(ev.toolUseId, { tool: ev.tool, dog: dogStateFor(ev), trainer: trainerStateFor(ev), detail: dogDetail(ev) });
      return false;
    }
    if (!ev.toolUseId || !["PostToolUse", "PostToolUseFailure", "PermissionDenied"].includes(ev.event)) return false;
    // A result we never saw start: our bookkeeping is out of sync, so start over.
    if (!s.inFlight.delete(ev.toolUseId)) {
      s.inFlight.clear();
      return false;
    }
    const still = [...s.inFlight.values()].pop();
    if (!still) return false;
    if (still.dog) setState(s.companion, still.dog, now, still.detail, still.tool);
    setState(s.trainer, still.trainer ?? "idle", now, null, still.tool);
    return true;
  }

  /** PostToolUse(Agent): if it carries an agentId, links the description to that puppy. */
  private linkSpawn(s: Session, ev: NormalizedEvent): void {
    const idx = ev.toolUseId ? s.pendingSpawns.findIndex((p) => p.toolUseId === ev.toolUseId) : -1;
    const pending = idx >= 0 ? s.pendingSpawns[idx] : undefined;
    if (!ev.spawnedAgentId || !pending) return;
    s.pendingSpawns.splice(idx, 1);
    if (!pending.description) return;
    const puppy = s.puppies.get(ev.spawnedAgentId);
    if (puppy) puppy.name = pending.description;
    else s.namesByAgentId.set(ev.spawnedAgentId, pending.description);
  }

  private anyoneAsking(s: Session): boolean {
    if (s.companion.state === "asks") return true;
    for (const p of s.puppies.values()) if (p.state === "asks") return true;
    return false;
  }

  /** The trainer stops pointing once nobody is asking for permission. */
  private settleTrainer(s: Session, now: number): void {
    if (s.trainer.state === "points" && !this.anyoneAsking(s)) setState<TrainerState>(s.trainer, "idle", now);
  }

  private expirePending(s: Session, now: number): boolean {
    const before = s.pendingSpawns.length;
    s.pendingSpawns = s.pendingSpawns.filter((p) => now - p.at <= this.opts.pendingSpawnMs);
    return s.pendingSpawns.length !== before;
  }

  private bucket(s: Session): Bucket {
    if (s.endedAt !== null) return "ended";
    if (s.trainer.state === "points" || this.anyoneAsking(s)) return "needs_you";
    // Debounce: between two tools the trainer is idle, but the turn is still
    // running or there are puppies out.
    const puppiesOut = [...s.puppies.values()].some((p) => p.leavingAt === null);
    if (s.turnActive || puppiesOut) return "working";
    return "done";
  }

  /** The configured dog, filling in a coat per project when only the breed is set. */
  private companionLook(s: Session): { breed: Breed; coat: string } {
    const look = configuredCompanion(this.config, s.cwd);
    if (look?.coat) return { breed: look.breed, coat: look.coat };
    return companionLookFor(s.cwd ?? s.id, look?.breed);
  }

  private toView(s: Session): SessionView {
    return {
      id: s.id,
      platform: s.platform,
      project: projectName(s),
      scenario: s.scenario,
      trainerLook: trainerLookFor(s.cwd ?? s.id),
      companionLook: this.companionLook(s),
      bucket: this.bucket(s),
      trainer: { ...s.trainer },
      companion: { ...s.companion },
      puppies: [...s.puppies.values()].map(({ leavingAt: _leavingAt, ...view }) => ({ ...view })),
      obstacles: s.completed.size,
      fetching: [...s.inFlight.values()].filter((t) => t.dog === "fetches").length,
      startedAt: s.startedAt,
      lastEventAt: s.lastEventAt,
      endedAt: s.endedAt,
    };
  }
}
