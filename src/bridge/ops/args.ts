/** Argument validation helpers. Error messages name the argument (chosen by us), never echo app input. */
import { BridgeError } from "../errors";

export type Args = Record<string, unknown>;

const bad = (key: string) => new BridgeError("INVALID", `Bad argument: ${key}.`);

export function requireString(args: Args, key: string, max = 1024): string {
  const value = args[key];
  if (typeof value !== "string" || value.length > max) throw bad(key);
  return value;
}

export function optionalString(args: Args, key: string, max = 1024): string | undefined {
  return args[key] === undefined ? undefined : requireString(args, key, max);
}

export function optionalBool(args: Args, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw bad(key);
  return value;
}

export function optionalInt(args: Args, key: string, min: number, max: number, fallback: number): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw bad(key);
  return value;
}

export function requireObjectValue(args: Args, key: string): unknown {
  if (!(key in args)) throw bad(key);
  return args[key];
}

export function optionalEnum<T extends string>(args: Args, key: string, allowed: readonly T[], fallback: T): T {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw bad(key);
  return value as T;
}
