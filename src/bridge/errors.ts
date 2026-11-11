import type { ErrorCode } from "./protocol";

/** Generic messages. They never include paths or other app-supplied text. */
export const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  NOT_FOUND: "Not found.",
  DENIED: "Operation not permitted.",
  INVALID: "Invalid request.",
  UNSUPPORTED: "Unsupported operation.",
  TOO_LARGE: "Too large.",
  INTERNAL: "Internal error.",
};

export class BridgeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = "BridgeError";
  }
}
