import type { IncomingMessage } from "node:http";

/**
 * Access rules shared by every server route.
 *
 * The server only listens on 127.0.0.1, but that is not enough: any page open
 * in the browser can try to talk to 127.0.0.1, and a domain that resolves to
 * 127.0.0.1 (DNS rebinding) arrives with a foreign Host. So we check the remote
 * IP, the Host header and, depending on the route, the Origin header.
 */

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost"];

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

/** Host must be exactly 127.0.0.1:<port> or localhost:<port>. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return LOOPBACK_HOSTNAMES.some((name) => host.toLowerCase() === `${name}:${port}`);
}

/** Accepted browser origins (for the WebSocket and the page). */
export function allowedOrigins(port: number): string[] {
  return LOOPBACK_HOSTNAMES.map((name) => `http://${name}:${port}`);
}

export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  return origin !== undefined && allowedOrigins(port).includes(origin.toLowerCase());
}

/** Base check for any request: loopback IP and local Host. */
export function isLocalRequest(req: IncomingMessage, port: number): boolean {
  return isLoopbackAddress(req.socket.remoteAddress) && isAllowedHost(req.headers.host, port);
}
