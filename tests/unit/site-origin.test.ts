import { describe, expect, it } from "vitest";

import { normalizeOrigin } from "../../src/lib/site";

describe("normalizeOrigin", () => {
  it("returns one canonical origin without a trailing slash", () => {
    expect(normalizeOrigin("https://media.example.com/")).toBe(
      "https://media.example.com",
    );
    expect(normalizeOrigin("http://127.0.0.1:4323")).toBe(
      "http://127.0.0.1:4323",
    );
  });

  it.each([
    "media.example.com",
    "ftp://media.example.com",
    "https://user:secret@media.example.com",
    "https://media.example.com/files",
    "https://media.example.com?bucket=one",
    "https://media.example.com/#fragment",
  ])("rejects a value that is not an origin: %s", (value) => {
    expect(() => normalizeOrigin(value)).toThrow();
  });
});
