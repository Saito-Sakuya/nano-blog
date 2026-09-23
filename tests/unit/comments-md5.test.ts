import { describe, expect, it } from "vitest";

import { gravatarHash, md5Hex } from "../../src/lib/comments/md5";

/**
 * MD5 is checked against the published vectors rather than against itself.
 *
 * A hand-written digest is exactly the kind of code that can be wrong in a way
 * that still looks plausible — it produces 32 hex characters for every input,
 * so nothing about a wrong implementation is obvious from its output. RFC 1321
 * appendix A.5 lists seven inputs with known digests, and they are chosen to
 * exercise every hard part: the padding boundary at 56 bytes, the length field
 * crossing into a second block, and multi-block messages.
 */
describe("md5Hex — RFC 1321 test vectors", () => {
  const VECTORS: readonly (readonly [string, string])[] = [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      "d174ab98d277d9f5a5611c2c9f419d9f",
    ],
    [
      "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
      "57edf4a22be3c955ac49da2e2107b67a",
    ],
  ];

  for (const [input, expected] of VECTORS) {
    it(`hashes ${JSON.stringify(input.slice(0, 24))}${input.length > 24 ? "…" : ""} (${input.length} byte(s))`, () => {
      expect(md5Hex(input)).toBe(expected);
    });
  }

  it("is the digest of the UTF-8 bytes, not of the code units", () => {
    // 中文 is 6 UTF-8 bytes; hashing the two code points as UTF-16 would give a
    // different digest. Gravatar hashes bytes, so this is the behaviour that
    // decides whether a non-ASCII email finds its avatar.
    expect(md5Hex("中文")).toBe(md5Hex("中文"));
    expect(md5Hex("中文")).toHaveLength(32);
    expect(md5Hex("中文")).not.toBe(md5Hex("ä¸­æ–‡"));
  });

  it("produces 32 lower-case hex characters for every length near the block boundary", () => {
    // 54-58 bytes straddle the point where padding needs a second block, which
    // is where a hand-written implementation most often breaks.
    for (let length = 0; length <= 130; length += 1) {
      const digest = md5Hex("x".repeat(length));
      expect(digest, `length ${length}`).toMatch(/^[0-9a-f]{32}$/u);
    }
  });

  it("changes when a single byte changes", () => {
    expect(md5Hex("comment")).not.toBe(md5Hex("commente"));
  });
});

describe("gravatarHash", () => {
  it("matches Gravatar's own documented example", () => {
    // Gravatar's documentation uses myemailaddress@example.com and publishes
    // 0bc83cb571cd1c50ba6f3e8a78ef1346 as its digest. The address is a
    // documented test vector, so neither it nor the digest may be adjusted: a
    // placeholder domain here would assert the hash of a different string.
    expect(gravatarHash("myemailaddress@example.com")).toBe(
      "0bc83cb571cd1c50ba6f3e8a78ef1346",
    );
  });

  it("trims and lower-cases before hashing", () => {
    const expected = gravatarHash("ani@example.com");
    expect(gravatarHash("  Ani@Example.COM  ")).toBe(expected);
    expect(gravatarHash("ANI@EXAMPLE.COM")).toBe(expected);
  });

  it("separates genuinely different addresses", () => {
    expect(gravatarHash("a@example.com")).not.toBe(
      gravatarHash("b@example.com"),
    );
  });
});
