import { describe, expect, it } from "vitest";

import {
  assertFetchableOrigin,
  isBlockedHost,
} from "../../functions/lib/outbound-url.js";

/**
 * The guard on the one outbound request whose destination comes from input.
 *
 * The form that matters is not the obvious one. A check written against the URL
 * text misses `http://2130706433/` because the string does not contain
 * `127.0.0.1` — but `new URL` normalises it, which is why the guard takes a
 * parsed hostname and why these cases are written as full URLs throughout. An
 * earlier implementation of this kind of check in the wild compared strings and
 * let every one of the numeric forms through.
 */

/** Convenience: the hostname `new URL` produces for an input. */
function hostOf(raw: string): string {
  return new URL(raw).hostname;
}

describe("isBlockedHost", () => {
  it("blocks the plain local names", () => {
    for (const host of ["localhost", "localhost.", "LOCALHOST"]) {
      expect(isBlockedHost(host), host).toBe(true);
    }
  });

  it("blocks loopback in every spelling the URL parser accepts", () => {
    // Each of these is 127.0.0.1, and only the last two contain "127".
    for (const raw of [
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
    ]) {
      expect(isBlockedHost(hostOf(raw)), raw).toBe(true);
    }
  });

  it("blocks the private ranges", () => {
    for (const raw of [
      "http://10.0.0.1/",
      "http://10.255.255.254/",
      "http://172.16.0.1/",
      "http://172.31.255.254/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
    ]) {
      expect(isBlockedHost(hostOf(raw)), raw).toBe(true);
    }
  });

  it("blocks link-local, which is where instance metadata lives", () => {
    for (const raw of [
      "http://169.254.169.254/",
      "http://169.254.0.1/",
      "http://[fe80::1]/",
    ]) {
      expect(isBlockedHost(hostOf(raw)), raw).toBe(true);
    }
  });

  it("blocks the unspecified, multicast and reserved blocks", () => {
    for (const raw of [
      "http://0.0.0.0/",
      "http://224.0.0.1/",
      "http://240.0.0.1/",
      "http://192.0.2.1/",
      "http://198.18.0.1/",
      "http://[::]/",
      "http://[ff02::1]/",
    ]) {
      expect(isBlockedHost(hostOf(raw)), raw).toBe(true);
    }
  });

  it("blocks IPv6 loopback and IPv4-mapped IPv6, in the normalised form", () => {
    // `::ffff:127.0.0.1` is rewritten to hex by the parser, so a check for the
    // dotted form alone would not see it.
    for (const raw of [
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::127.0.0.1]/",
      "http://[::ffff:10.0.0.1]/",
      "http://[fc00::1]/",
      "http://[fd00::1]/",
    ]) {
      expect(isBlockedHost(hostOf(raw)), raw).toBe(true);
    }
  });

  it("blocks the local namespaces that are not the loopback literal", () => {
    for (const host of [
      "api.localhost",
      "printer.local",
      "metadata.google.internal",
      "thing.home.arpa",
    ]) {
      expect(isBlockedHost(host), host).toBe(true);
    }
  });

  it("allows ordinary public hosts", () => {
    for (const host of [
      "blog.example.invalid",
      "gravatar.com",
      "an-internal-thing.com",
      "notlocalhost.com",
      "172.32.0.1",
      "11.0.0.1",
      "8.8.8.8",
      "2606:4700::1111",
    ]) {
      expect(isBlockedHost(host), host).toBe(false);
    }
  });
});

describe("assertFetchableOrigin", () => {
  it("returns the parsed origin for a public https URL", () => {
    expect(assertFetchableOrigin("https://blog.example.invalid").origin).toBe(
      "https://blog.example.invalid",
    );
  });

  it("accepts http, which a preview deployment may still be served over", () => {
    expect(
      assertFetchableOrigin("http://blog.example.invalid:8788").origin,
    ).toBe("http://blog.example.invalid:8788");
  });

  it("refuses a scheme that is not http or https", () => {
    for (const raw of [
      "file:///etc/passwd",
      "ftp://example.invalid/x",
      "data:text/plain,hi",
      "javascript:alert(1)",
    ]) {
      expect(() => assertFetchableOrigin(raw), raw).toThrow();
    }
  });

  it("refuses a URL carrying credentials", () => {
    expect(() =>
      assertFetchableOrigin("https://user:pw@example.invalid"),
    ).toThrow(/credentials/);
  });

  it("refuses every blocked destination", () => {
    for (const raw of [
      "http://127.0.0.1:4321",
      "http://localhost:4321",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]:4321",
      "http://10.0.0.1",
    ]) {
      expect(() => assertFetchableOrigin(raw), raw).toThrow(/public host/);
    }
  });

  it("refuses something that is not a URL at all", () => {
    expect(() => assertFetchableOrigin("not a url")).toThrow(/not a URL/);
  });
});
