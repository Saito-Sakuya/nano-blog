import { compareCodePoints } from "../lib/unicode.js";

/**
 * Canonical JSON.
 *
 * One byte string for one value, whatever order the keys happened to be
 * inserted in. Digests are computed over this form, so two releases holding
 * identical content produce an identical digest — which is what makes the
 * release id, the manifest check and the cleanup plan digest meaningful.
 *
 * The rules are deliberately narrow: objects must be plain, keys are sorted by
 * Unicode code point, no whitespace is emitted, and values that JSON cannot
 * represent unambiguously (functions, symbols, bigints, `Date`, class
 * instances, `NaN`, `Infinity`) are rejected instead of being coerced into
 * something that would hash differently on another runtime.
 */

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export class CanonicalJsonError extends Error {
  override readonly name = "CanonicalJsonError";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function serialize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(
          `Canonical JSON cannot represent ${String(value)} at ${path}.`,
        );
      }
      // `-0` and `0` are the same JSON number; normalise so they hash alike.
      return JSON.stringify(value === 0 ? 0 : value);
    }

    case "string":
      return JSON.stringify(value);

    case "undefined":
      throw new CanonicalJsonError(
        `Canonical JSON cannot represent undefined at ${path}.`,
      );

    case "bigint":
      throw new CanonicalJsonError(
        `Canonical JSON cannot represent a bigint at ${path}.`,
      );

    case "function":
    case "symbol":
      throw new CanonicalJsonError(
        `Canonical JSON cannot represent a ${typeof value} at ${path}.`,
      );

    default:
      break;
  }

  if (typeof value !== "object") {
    throw new CanonicalJsonError(
      `Canonical JSON cannot represent ${typeof value} at ${path}.`,
    );
  }

  if (seen.has(value)) {
    throw new CanonicalJsonError(
      `Canonical JSON cannot represent a circular structure at ${path}.`,
    );
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items = value.map((item, index) =>
        serialize(item, `${path}[${index}]`, seen),
      );
      return `[${items.join(",")}]`;
    }

    if (!isPlainObject(value)) {
      throw new CanonicalJsonError(
        `Canonical JSON accepts plain objects only, but ${path} is ${describe(value)}.`,
      );
    }

    const keys = Object.keys(value).sort(compareCodePoints);
    const members: string[] = [];
    for (const key of keys) {
      const member = value[key];
      // An absent optional field and a field explicitly set to undefined are
      // the same thing in JSON, so both are simply not emitted.
      if (member === undefined) continue;
      members.push(
        `${JSON.stringify(key)}:${serialize(member, `${path}.${key}`, seen)}`,
      );
    }
    return `{${members.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function describe(value: object): string {
  const name = value.constructor?.name;
  return name === undefined || name.length === 0 ? "a non-plain object" : name;
}

/** Serialise a value to its canonical JSON form. */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$", new Set<object>());
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), "utf8");
}
