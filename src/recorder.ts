import { createWriteStream, mkdirSync, openSync, type WriteStream } from "node:fs";
import { join } from "node:path";

/**
 * Record mode (opt-in): stores the raw hook payloads as JSONL.
 *
 * These files contain paths, commands and file contents. They go to a
 * git-ignored directory, readable only by the user.
 */

export interface RecordLine {
  /** Recording format version. */
  v: 1;
  /** Epoch ms when the server received the event. */
  receivedAt: number;
  /** Epoch ms when the forwarder started sending it (X-Zoomies-Sent-At header), if present. */
  sentAt: number | null;
  /** Host that emitted it, when not Claude Code (codex, copilot). */
  source?: string;
  /** Payload exactly as the host emitted it. */
  payload: unknown;
}

export class Recorder {
  readonly file: string;
  private readonly stream: WriteStream;

  constructor(dir: string, now: Date = new Date()) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    this.file = join(dir, `${stamp}.jsonl`);
    // Synchronous open: the file exists right away, with 0600 permissions.
    const fd = openSync(this.file, "a", 0o600);
    this.stream = createWriteStream(this.file, { fd });
  }

  write(line: RecordLine): void {
    this.stream.write(JSON.stringify(line) + "\n");
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}
