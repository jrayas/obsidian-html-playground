/** Bridge message types and envelope guards (pure). See docs/bridge-api.md. */

export type ErrorCode = "NOT_FOUND" | "DENIED" | "INVALID" | "UNSUPPORTED" | "TOO_LARGE" | "INTERNAL";

export interface BridgeRequest {
  v: 1;
  id: string;
  type: "request";
  op: string;
  args: Record<string, unknown>;
}

export interface BridgeResponse {
  v: 1;
  id: string;
  type: "response";
  ok: boolean;
  result?: unknown;
  error?: { code: ErrorCode; message: string };
}

export interface BridgeEvent {
  v: 1;
  type: "event";
  name: string;
  payload: unknown;
}

const MAX_ID_LENGTH = 64;
const MAX_OP_LENGTH = 64;

/** Returns a well-formed request, or null. Malformed messages are ignored, never answered. */
export function parseRequest(data: unknown): BridgeRequest | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.v !== 1 || m.type !== "request") return null;
  if (typeof m.id !== "string" || m.id.length === 0 || m.id.length > MAX_ID_LENGTH) return null;
  if (typeof m.op !== "string" || m.op.length === 0 || m.op.length > MAX_OP_LENGTH) return null;
  const args = m.args === undefined ? {} : m.args;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  return { v: 1, id: m.id, type: "request", op: m.op, args: args as Record<string, unknown> };
}

export const okResponse = (id: string, result: unknown): BridgeResponse => ({
  v: 1,
  id,
  type: "response",
  ok: true,
  result,
});

export const errorResponse = (id: string, code: ErrorCode, message: string): BridgeResponse => ({
  v: 1,
  id,
  type: "response",
  ok: false,
  error: { code, message },
});

export const eventMessage = (name: string, payload: unknown): BridgeEvent => ({
  v: 1,
  type: "event",
  name,
  payload,
});
