#!/usr/bin/env node
// zoomies-hook: forwards the JSON that Claude Code passes on stdin to
// http://127.0.0.1:<port>/event.
//
// Rules (a Claude Code session must never notice this process):
// - Writes NOTHING to stdout or stderr: Claude Code reads stdout as the
//   hook's control JSON.
// - Always exits with code 0, no matter what.
// - Short timeout; with the server down, the connection is refused instantly.
// - Fixed host 127.0.0.1: only the port can change (ZOOMIES_PORT).
// - Ignores the server's response.
//
// CommonJS + node:net on purpose: starting an .mjs that imports node:http
// costs ~85 ms per event; this way it stays at ~30 ms (close to starting an
// empty Node).
"use strict";

const exit = () => process.exit(0);
process.on("uncaughtException", exit);
process.on("unhandledRejection", exit);

// Hard cap on the process lifetime (in case stdin never closes).
setTimeout(exit, 1000);

const net = require("node:net");

const REQUEST_TIMEOUT_MS = 300;
// Below the server limit (2 MiB).
const MAX_RAW_BYTES = 1024 * 1024;
const envPort = process.env.ZOOMIES_PORT || "";
const PORT = /^\d{1,5}$/.test(envPort) && Number(envPort) > 0 && Number(envPort) < 65536 ? Number(envPort) : 3737;
const sentAt = Date.now();
// `--source codex|copilot`: which host runs this hook (Claude Code when absent).
const sourceArg = process.argv[process.argv.indexOf("--source") + 1] || "";
const SOURCE = process.argv.includes("--source") && /^[a-z]{1,16}$/.test(sourceArg) ? sourceArg : "";

/** If the payload is huge (e.g. a big Write), drops the heavy fields. */
function shrink(raw) {
  const data = JSON.parse(raw);
  delete data.tool_response;
  delete data.last_assistant_message;
  if (data.tool_input && typeof data.tool_input === "object") {
    for (const key of ["content", "old_string", "new_string", "edits", "new_source"]) delete data.tool_input[key];
  }
  data._zoomies_trimmed = true;
  return JSON.stringify(data);
}

function send(body) {
  const payload = Buffer.from(body, "utf8");
  const head =
    "POST /event HTTP/1.1\r\n" +
    `Host: 127.0.0.1:${PORT}\r\n` +
    "Content-Type: application/json\r\n" +
    `Content-Length: ${payload.length}\r\n` +
    `X-Zoomies-Sent-At: ${sentAt}\r\n` +
    (SOURCE ? `X-Zoomies-Source: ${SOURCE}\r\n` : "") +
    "Connection: close\r\n\r\n";
  const socket = net.connect({ host: "127.0.0.1", port: PORT });
  socket.setTimeout(REQUEST_TIMEOUT_MS, exit);
  socket.on("error", exit);
  socket.on("connect", () => {
    socket.write(head);
    socket.write(payload);
  });
  // With the first response (or the close) it has been delivered.
  socket.on("data", exit);
  socket.on("close", exit);
}

const chunks = [];
let size = 0;
process.stdin.on("data", (chunk) => {
  size += chunk.length;
  chunks.push(chunk);
});
process.stdin.on("error", exit);
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return exit();
  send(size > MAX_RAW_BYTES ? shrink(raw) : raw);
});
