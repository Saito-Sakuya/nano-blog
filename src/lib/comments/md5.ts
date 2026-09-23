/**
 * MD5, because Gravatar is addressed by it.
 *
 * MD5 is not used here as a security primitive and must not be: it is broken for
 * collision resistance, and anything that needed that property would be wrong to
 * use it. It is used for exactly one thing — Gravatar's avatar URL is
 * `https://gravatar.com/avatar/<md5-of-lowercased-trimmed-email>`, and that
 * endpoint defines the hash, not us. The digest is computed over the email only
 * to form a lookup key; the email itself is never stored.
 *
 * Written out rather than pulled from a package because the alternative is a
 * dependency for forty lines of arithmetic, and because a hand-written MD5 with
 * the RFC 1321 test vectors next to it is easier to audit than a transitive
 * tree. `tests/unit/comments-md5.test.ts` checks all seven published vectors,
 * including the multi-block ones that exercise padding and length encoding.
 */

/** Left-rotation of a 32-bit word. */
function rotateLeft(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

/** Per-round shift amounts, and the sine-derived constants, from RFC 1321. */
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21,
] as const;

const CONSTANTS = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
  0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
  0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
  0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
  0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
  0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
] as const;

/**
 * The MD5 digest of a UTF-8 string, as 32 lower-case hex characters.
 *
 * Input is hashed as its UTF-8 bytes, which is what Gravatar does: an email with
 * non-ASCII characters must produce the digest of its byte encoding, not of its
 * code units.
 */
export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;

  // Pad to a multiple of 64 bytes: a single 0x80, zeros, then the length as a
  // 64-bit little-endian integer.
  const withPadding = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  withPadding.set(bytes);
  withPadding[bytes.length] = 0x80;

  const view = new DataView(withPadding.buffer);
  // The high word is written for completeness; message lengths here are far
  // below 2^32 bits, so it is always zero in practice.
  view.setUint32(withPadding.length - 8, bitLength >>> 0, true);
  view.setUint32(
    withPadding.length - 4,
    Math.floor(bitLength / 0x100000000),
    true,
  );

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const words = new Uint32Array(16);

  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, true);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;

      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }

      const constant = CONSTANTS[index] ?? 0;
      const shift = SHIFTS[index] ?? 0;
      const word = words[g] ?? 0;

      const sum = (a + f + constant + word) | 0;
      const rotated = rotateLeft(sum, shift);

      a = d;
      d = c;
      c = b;
      b = (b + rotated) | 0;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const hex = (value: number): string => {
    let out = "";
    for (let index = 0; index < 4; index += 1) {
      out += ((value >>> (index * 8)) & 0xff).toString(16).padStart(2, "0");
    }
    return out;
  };

  return `${hex(a0)}${hex(b0)}${hex(c0)}${hex(d0)}`;
}

/**
 * The Gravatar lookup key for an email address.
 *
 * Gravatar's own rule: trim surrounding whitespace and lower-case before
 * hashing, so `Ani@Example.com ` and `ani@example.invalid` are the same avatar.
 */
export function gravatarHash(email: string): string {
  return md5Hex(email.trim().toLowerCase());
}
