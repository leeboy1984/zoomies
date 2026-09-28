import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ZoomiesConfig } from "./config.js";
import { sanitize, toPlatform } from "./mapping/sanitize.js";
import { RateLimiter } from "./rate-limit.js";
import type { Recorder } from "./recorder.js";
import { isAllowedOrigin, isLocalRequest } from "./security.js";
import { SessionStore, type SessionView, type StoreOptions } from "./state/store.js";

export const DEFAULT_PORT = 3737;
export const BIND_HOST = "127.0.0.1";
/** Maximum payload size. The forwarder trims below this. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_WS_CLIENTS = 16;
export const SWEEP_INTERVAL_MS = 1_000;
export const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

/** Serves files from public/ (read-only, known extensions only). */
async function serveStatic(pathname: string, res: ServerResponse, port: number, headOnly: boolean): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    return send(res, 400);
  }
  if (decoded.includes("\0")) return send(res, 400);
  const file = resolve(PUBLIC_DIR, "." + decoded);
  const type = MIME[extname(file)];
  if (!file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep) || !type) return send(res, 404);
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return send(res, 404);
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; ` +
      `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  });
  res.end(headOnly ? undefined : body);
}

export interface ServerOptions {
  /** 0 = random free port (tests). */
  port?: number;
  recorder?: Recorder;
  store?: Partial<StoreOptions>;
  config?: ZoomiesConfig;
  rateLimit?: { limit: number; windowMs: number };
  /** Injectable clock (tests and replay). */
  now?: () => number;
}

/** Server → browser messages. */
export type ServerMessage =
  | { type: "snapshot"; sessions: SessionView[] }
  | { type: "session"; session: SessionView }
  | { type: "remove"; id: string };

export interface ZoomiesServer {
  server: Server;
  port: number;
  store: SessionStore;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(String(status));
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY_BYTES) return reject(new HttpError(413));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number): void {
  // Bodyless responses: the forwarder never reads them and they must never be
  // mistaken for a hook's control JSON.
  res.writeHead(status, { "Cache-Control": "no-store" });
  res.end();
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function startServer(opts: ServerOptions = {}): Promise<ZoomiesServer> {
  let boundPort = opts.port ?? DEFAULT_PORT;
  const now = opts.now ?? Date.now;
  const store = new SessionStore(opts.store, opts.config);
  const limiter = new RateLimiter(opts.rateLimit?.limit, opts.rateLimit?.windowMs);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, clientTracking: true });

  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(data);
  };
  const publish = (id: string) => {
    const session = store.view(id);
    broadcast(session ? { type: "session", session } : { type: "remove", id });
  };

  async function handleEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A browser always sends Origin on a cross-origin POST; the forwarder never does.
    if (req.headers.origin !== undefined) return send(res, 403);
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) return send(res, 415);

    const body = await readBody(req);
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return send(res, 400);
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return send(res, 400);

    const receivedAt = now();
    // The forwarder says which host it runs for (Claude Code when absent).
    const platform = toPlatform(req.headers["x-zoomies-source"]);
    const event = sanitize(payload, platform);
    if (event && !limiter.allow(event.sessionId, receivedAt)) return send(res, 429);

    const sentAtHeader = Number(req.headers["x-zoomies-sent-at"]);
    opts.recorder?.write({
      v: 1,
      receivedAt,
      sentAt: Number.isFinite(sentAtHeader) && sentAtHeader > 0 ? sentAtHeader : null,
      ...(platform !== "claude" ? { source: platform } : {}),
      payload,
    });
    // The raw payload never leaves this function: from here on only `event` exists.
    payload = undefined;
    send(res, event ? 204 : 400);
    if (event) publish(store.apply(event, receivedAt));
  }

  const server = createServer((req, res) => {
    if (!isLocalRequest(req, boundPort)) return send(res, 403);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/event") {
      if (req.method !== "POST") return send(res, 405);
      handleEvent(req, res).catch((err: unknown) => {
        if (!res.headersSent) send(res, err instanceof HttpError ? err.status : 500);
      });
      return;
    }
    if (url.pathname === "/health" && req.method === "GET") return send(res, 204);
    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(url.pathname, res, boundPort, req.method === "HEAD").catch(() => {
        if (!res.headersSent) send(res, 500);
      });
      return;
    }
    send(res, 405);
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws") return reject(socket, 404, "Not Found");
    // Any page open in the browser can try to open this WebSocket: only the
    // local IP, Host and Origin are accepted.
    if (!isLocalRequest(req, boundPort) || !isAllowedOrigin(req.headers.origin, boundPort)) {
      return reject(socket, 403, "Forbidden");
    }
    if (wss.clients.size >= MAX_WS_CLIENTS) return reject(socket, 503, "Service Unavailable");
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      ws.on("message", () => {}); // the client sends nothing useful
      ws.on("error", () => ws.terminate());
      ws.send(JSON.stringify({ type: "snapshot", sessions: store.snapshot() } satisfies ServerMessage));
    });
  });

  const sweeper = setInterval(() => {
    const { changed, removed } = store.sweep(now());
    for (const id of changed) publish(id);
    for (const id of removed) broadcast({ type: "remove", id });
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  return new Promise((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(boundPort, BIND_HOST, () => {
      boundPort = (server.address() as AddressInfo).port;
      resolve({
        server,
        port: boundPort,
        store,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(sweeper);
            for (const client of wss.clients) client.terminate();
            wss.close();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
