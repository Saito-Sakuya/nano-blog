import { describe, expect, it } from "vitest";

import {
  MIN_SECRET_FRAGMENT_LENGTH,
  MIN_SECRET_LENGTH,
  REDACTED,
  describeSecret,
  redactSecretsIn,
} from "../../scripts/lib/redact";

/**
 * Redaction is the last line of defence between a credential and a log file.
 * The cases below are the ones the old exact-match rule let through: a short
 * credential, and any prefix or suffix of a long one.
 */

/** A realistic R2 secret: long, high entropy, never repeated in prose. */
const SECRET =
  "b7f4c1e08d3a9f265b0c7e14a8d3f69012ab34cd56ef7890a1b2c3d4e5f60718";

describe("redactSecretsIn", () => {
  it("replaces the whole value wherever it appears", () => {
    const text = `access key ${SECRET} used\n`;
    expect(redactSecretsIn(text, [SECRET])).toBe(
      `access key ${REDACTED} used\n`,
    );
  });

  it("replaces a prefix of the value", () => {
    expect(redactSecretsIn(`key=${SECRET.slice(0, 10)}`, [SECRET])).toBe(
      `key=${REDACTED}`,
    );
  });

  it("replaces a suffix of the value", () => {
    expect(redactSecretsIn(`…${SECRET.slice(-12)}`, [SECRET])).toBe(
      `…${REDACTED}`,
    );
  });

  it("replaces a middle run, not just fixed-width windows of it", () => {
    // A window-based implementation leaves the tail of a longer quote behind.
    const leaked = SECRET.slice(8, 28);
    expect(redactSecretsIn(`token ${leaked} end`, [SECRET])).toBe(
      `token ${REDACTED} end`,
    );
  });

  it("replaces several occurrences and several secrets", () => {
    const other = "z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4";
    expect(redactSecretsIn(`${SECRET} and ${other}`, [SECRET, other])).toBe(
      `${REDACTED} and ${REDACTED}`,
    );
    expect(redactSecretsIn(`${SECRET} and ${SECRET}`, [SECRET])).toBe(
      `${REDACTED} and ${REDACTED}`,
    );
  });

  it("ignores absent secrets", () => {
    expect(redactSecretsIn("nothing to hide", [undefined])).toBe(
      "nothing to hide",
    );
  });

  it("leaves prose alone when no fragment of a secret appears in it", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    expect(redactSecretsIn(text, [SECRET])).toBe(text);
  });

  it("masks a value as short as the documented floor", () => {
    expect(MIN_SECRET_LENGTH).toBeLessThan(8);
    expect(redactSecretsIn("value=abcd", ["abcd"])).toBe(`value=${REDACTED}`);
  });

  it("leaves values below the floor alone, and says so", () => {
    // The floor is deliberate: a one- or two-character "secret" would blank out
    // every occurrence of those characters in every log line. No credential
    // this tooling reads is that short.
    const text = "value=abc";
    expect(redactSecretsIn(text, ["abc"])).toBe(text);
  });

  it("leaves a fragment shorter than the fragment floor alone", () => {
    const fragment = SECRET.slice(0, MIN_SECRET_FRAGMENT_LENGTH - 1);
    const text = `value=${fragment}`;
    expect(redactSecretsIn(text, [SECRET])).toBe(text);
  });

  it("never grows the text it is given", () => {
    const text = `before ${SECRET} after`;
    expect(redactSecretsIn(text, [SECRET]).length).toBeLessThanOrEqual(
      text.length,
    );
  });
});

describe("describeSecret", () => {
  it("reports presence without the value", () => {
    expect(describeSecret(SECRET)).toBe("set (redacted)");
    expect(describeSecret(undefined)).toBe("unset");
    expect(describeSecret("")).toBe("unset");
  });
});
