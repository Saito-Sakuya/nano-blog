/**
 * What an outbound request from the Functions layer is allowed to reach.
 *
 * Exactly one request in this layer builds its target from the incoming request
 * rather than from a compile-time constant: the closed-posts manifest, which is
 * read back from the deployment that served the page. A URL derived from input
 * is worth checking before it is fetched, because a host that resolved to
 * loopback, a private range or a link-local address would turn the function into
 * a probe of whatever sits behind it.
 *
 * Two rules, both about the destination:
 *
 * - only `http:` and `https:` may be fetched, and a URL may not carry
 *   credentials — a `user:pass@host` form is a way to make one host read as
 *   another in a log line;
 * - the host may not be loopback, private, link-local, multicast or otherwise
 *   reserved.
 *
 * The check runs on the **parsed** hostname rather than on the string, and that
 * is the whole reason it works: `2130706433`, `0x7f.1`, `0177.0.0.1` and
 * `[::ffff:127.0.0.1]` all normalise to `127.0.0.1`, so a check written against
 * the text would miss every one of them. `isBlockedHost` takes the normalised
 * form and is exported so it can be tested directly.
 *
 * The avatar proxy is not routed through this: its host is the literal
 * `https://gravatar.com/avatar` and the only variable part of its URL is a
 * 32-character hex digest, so there is no caller-supplied destination to
 * validate.
 */

/** The two schemes a request may be made over. */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * IPv4 ranges that must never be reached from a request-derived URL.
 *
 * Each entry is a network address followed by its prefix length. The list is the
 * IANA special-purpose set that matters for this decision: "this network",
 * private, carrier-grade NAT, loopback, link-local (where cloud metadata
 * services live), the IETF and documentation blocks, benchmarking, multicast and
 * the reserved top quarter.
 */
const BLOCKED_V4: readonly (readonly [number, number])[] = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

/** Suffixes that name a local or non-public namespace rather than a host. */
const BLOCKED_SUFFIXES: readonly string[] = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
];

/** The IPv4 forms that appear inside a normalised IPv6 literal. */
const MAPPED_TAIL = /^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u;
/** A dotted quad, as the URL parser leaves it. */
const DOTTED_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

function isBlockedV4(a: number, b: number, c: number, d: number): boolean {
  const value = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

/** `inner` is a bracketed IPv6 literal with the brackets removed. */
function isBlockedV6(inner: string): boolean {
  if (inner === "" || inner === "::" || inner === "::1") return true;

  const first = inner.split(":")[0] ?? "";
  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
  if (/^f[cd][0-9a-f]{0,2}$/u.test(first)) return true;
  if (/^fe[89ab][0-9a-f]?$/u.test(first)) return true;
  if (/^ff[0-9a-f]{0,2}$/u.test(first)) return true;
  // 2001:db8::/32 documentation.
  if (inner.startsWith("2001:db8:")) return true;

  /*
   * IPv4-mapped (`::ffff:127.0.0.1`) and IPv4-compatible (`::127.0.0.1`) forms.
   * The URL parser rewrites both into hex — `[::ffff:7f00:1]` and `[::7f00:1]` —
   * so the trailing 32 bits have to be decoded and checked as an IPv4 address.
   */
  const tail = inner.match(MAPPED_TAIL);
  if (tail !== null) {
    const hi = Number.parseInt(tail[1] ?? "0", 16);
    const lo = Number.parseInt(tail[2] ?? "0", 16);
    return isBlockedV4(hi >> 8, hi & 0xff, lo >> 8, lo & 0xff);
  }

  return false;
}

/**
 * Whether a parsed hostname names somewhere the deployment must not reach.
 *
 * Takes the output of `new URL(...).hostname`, which is already lowercased and
 * normalised. A trailing dot is stripped first: `localhost.` is the same host as
 * `localhost` and the parser keeps the dot.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  if (host === "") return true;

  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return true;
  }

  if (host.startsWith("[")) return isBlockedV6(host.slice(1, -1));

  const quad = host.match(DOTTED_QUAD);
  if (quad !== null) {
    return isBlockedV4(
      Number(quad[1]),
      Number(quad[2]),
      Number(quad[3]),
      Number(quad[4]),
    );
  }

  return false;
}

/**
 * Parse an origin and refuse it unless it is somewhere safe to fetch.
 *
 * Throws rather than returning a flag: every caller is about to fetch, and a
 * caller that ignored a `false` would be exactly the bug this exists to prevent.
 */
export function assertFetchableOrigin(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${JSON.stringify(raw)} is not a URL.`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      `Only http and https may be fetched, not ${url.protocol.slice(0, -1)}.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("A fetchable URL may not carry credentials.");
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error(`${url.hostname} is not a public host.`);
  }

  return url;
}
