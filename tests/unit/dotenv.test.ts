import { describe, expect, it } from "vitest";

import { parseDotEnv } from "../../scripts/lib/env";

/**
 * `.env` parsing.
 *
 * The values here end up in `process.env`, so a parser that is merely
 * "good enough" is a parser that puts a comment, a stray quote or half a URL
 * into a credential. The cases below are the shapes an author actually writes:
 * a quoted secret followed by a comment, a `#` that is part of the value, and
 * the escape sequences the format documents.
 */

function valueOf(line: string, name = "K"): string | undefined {
  return parseDotEnv(line, "test.env").values.get(name);
}

describe("parseDotEnv — quoting", () => {
  it("ends a double-quoted value at its closing quote, not at the last quote", () => {
    // The reported bug: `lastIndexOf('"')` read the comment as part of the
    // value, so the value became `v" # don't change`.
    expect(valueOf(`K="v" # don't change`)).toBe("v");
  });

  it("ends a single-quoted value at its own closing quote", () => {
    expect(valueOf("K='v' # don't change")).toBe("v");
    expect(valueOf("K='v' # it's fine")).toBe("v");
  });

  it("keeps a `#` that is inside the quotes", () => {
    expect(valueOf('K="a#b"')).toBe("a#b");
    expect(valueOf("K='a#b' # comment")).toBe("a#b");
  });

  it("keeps an escaped quote inside a double-quoted value", () => {
    expect(valueOf(String.raw`K="a\"b"`)).toBe('a"b');
    expect(valueOf(String.raw`K="a\"b" # c`)).toBe('a"b');
  });

  it("reads an empty quoted value as empty", () => {
    expect(valueOf('K=""')).toBe("");
    expect(valueOf("K=''")).toBe("");
  });

  it("accepts a quoted value after `export`", () => {
    expect(valueOf('export K="v" # c')).toBe("v");
  });

  it("takes the rest of the line when a quote is never closed", () => {
    // dotenv is tolerant here and so is this parser: an unterminated quote is
    // read as text rather than silently discarded.
    expect(valueOf('K="v')).toBe("v");
  });
});

describe("parseDotEnv — escapes", () => {
  it("resolves the documented escapes inside double quotes", () => {
    expect(valueOf(String.raw`K="a\nb"`)).toBe("a\nb");
    expect(valueOf(String.raw`K="a\rb"`)).toBe("a\rb");
    expect(valueOf(String.raw`K="a\tb"`)).toBe("a\tb");
    expect(valueOf(String.raw`K="a\\b"`)).toBe("a\\b");
  });

  it("resolves an escaped backslash before an escape letter", () => {
    // `\\n` is a literal backslash followed by `n`, not a newline. Sequential
    // replace passes turned it into a backslash plus a newline.
    expect(valueOf(String.raw`K="a\\nb"`)).toBe(String.raw`a\nb`);
  });

  it("keeps an escape it does not understand verbatim", () => {
    expect(valueOf(String.raw`K="C:\Users\x"`)).toBe(String.raw`C:\Users\x`);
  });

  it("does not process escapes inside single quotes", () => {
    expect(valueOf(String.raw`K='a\nb'`)).toBe(String.raw`a\nb`);
  });
});

describe("parseDotEnv — unquoted values and comments", () => {
  it("ends an unquoted value at a ` #` comment", () => {
    expect(valueOf("K=v # comment")).toBe("v");
    expect(valueOf("K=v   # comment")).toBe("v");
  });

  it("keeps a `#` with no space before it", () => {
    expect(valueOf("K=v#x")).toBe("v#x");
  });

  it("trims the value", () => {
    expect(valueOf("K=  v  ")).toBe("v");
  });

  it("ignores blank lines and full-line comments", () => {
    const parsed = parseDotEnv("# a comment\n\nK=v\n", "test.env");
    expect([...parsed.values]).toEqual([["K", "v"]]);
    expect(parsed.warnings).toEqual([]);
  });

  it("records a line that is not an assignment as a warning", () => {
    const parsed = parseDotEnv("K=v\nNOT_AN_ASSIGNMENT\n", "test.env");
    expect(parsed.values.get("K")).toBe("v");
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatch(/test\.env:2/u);
  });

  it("rejects an invalid variable name rather than exporting it", () => {
    const parsed = parseDotEnv("2BAD=v\n", "test.env");
    expect(parsed.values.size).toBe(0);
    expect(parsed.warnings[0]).toMatch(/invalid variable name/u);
  });

  it("reads several variables in one file", () => {
    const parsed = parseDotEnv(
      ['A="one" # comment', "B=two", "C='three'"].join("\n"),
      "test.env",
    );
    expect([...parsed.values]).toEqual([
      ["A", "one"],
      ["B", "two"],
      ["C", "three"],
    ]);
  });
});
