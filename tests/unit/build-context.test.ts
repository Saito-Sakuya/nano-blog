import { afterEach, describe, expect, it } from "vitest";

import {
  buildNow,
  parseBuildNowPin,
  resetBuildNow,
} from "../../src/lib/content/build-context";

/**
 * The one instant a build calls "now".
 *
 * `BUILD_NOW` exists so a test can pin the clock. It is not a deployment
 * control: a pin left in a production environment freezes every visibility
 * decision the site makes, so the value is refused there and validated
 * everywhere else.
 */

const REFERENCE = new Date("2026-09-15T00:00:00.000Z");

describe("parseBuildNowPin — accepted pins", () => {
  it("accepts a strict ISO instant with a Z offset", () => {
    expect(
      parseBuildNowPin("2026-09-15T00:00:00.000Z", {
        siteEnv: "local",
        now: REFERENCE,
      }).toISOString(),
    ).toBe("2026-09-15T00:00:00.000Z");
  });

  it("accepts a strict ISO instant with a numeric offset", () => {
    expect(
      parseBuildNowPin("2026-09-15T08:00:00+08:00", {
        siteEnv: "local",
        now: REFERENCE,
      }).getTime(),
    ).toBe(REFERENCE.getTime());
  });

  it("accepts a pin without fractional seconds", () => {
    expect(
      parseBuildNowPin("2026-09-15T00:00:00Z", {
        siteEnv: "preview",
        now: REFERENCE,
      }).getTime(),
    ).toBe(REFERENCE.getTime());
  });

  it("accepts a pin years away from the clock, because a fixture ages", () => {
    // The pinned value in `vitest.config.ts` is a fixed date: it stays valid as
    // the calendar moves. Only a century-scale mistake is refused.
    expect(
      parseBuildNowPin("2028-01-01T00:00:00Z", {
        siteEnv: "local",
        now: REFERENCE,
      }).getTime(),
    ).toBe(Date.parse("2028-01-01T00:00:00Z"));
  });
});

describe("parseBuildNowPin — refused pins", () => {
  it("refuses a pin in a production build", () => {
    expect(() =>
      parseBuildNowPin("2026-09-15T00:00:00.000Z", {
        siteEnv: "production",
        now: REFERENCE,
      }),
    ).toThrow(/production/u);
  });

  it("refuses text that is not ISO 8601", () => {
    // `new Date()` accepts all of these, in the host's locale and zone. A build
    // that treats "5/1/2026" as an instant is a build whose "now" depends on
    // the machine it runs on.
    for (const raw of [
      "2026",
      "5/1/2026",
      "March 3 2026",
      "2026-09-15",
      "2026-09-15T00:00:00",
      "20260915T000000Z",
      "not a date",
    ]) {
      expect(
        () => parseBuildNowPin(raw, { siteEnv: "local", now: REFERENCE }),
        raw,
      ).toThrow(/strict ISO 8601/u);
    }
  });

  it("refuses a pin far away from the current time", () => {
    // 2062 for 2026 is the typo this bound exists for.
    expect(() =>
      parseBuildNowPin("2062-09-15T00:00:00Z", {
        siteEnv: "local",
        now: REFERENCE,
      }),
    ).toThrow(/too far/u);

    expect(() =>
      parseBuildNowPin("1990-01-01T00:00:00Z", {
        siteEnv: "local",
        now: REFERENCE,
      }),
    ).toThrow(/too far/u);
  });
});

describe("buildNow", () => {
  afterEach(() => {
    resetBuildNow();
  });

  it("returns the pinned instant the test environment sets", () => {
    const pinned = process.env["BUILD_NOW"];
    expect(pinned, "vitest.config.ts pins BUILD_NOW").toBeDefined();
    expect(buildNow().toISOString()).toBe(new Date(pinned ?? "").toISOString());
  });

  it("reports an unusable pin instead of using it", () => {
    const original = process.env["BUILD_NOW"];
    process.env["BUILD_NOW"] = "5/1/2026";
    resetBuildNow();

    try {
      expect(() => buildNow()).toThrow(/strict ISO 8601/u);
    } finally {
      if (original === undefined) delete process.env["BUILD_NOW"];
      else process.env["BUILD_NOW"] = original;
      resetBuildNow();
    }

    // The pin is back, and reading the clock works again.
    expect(buildNow().toISOString()).toBe(
      new Date(original ?? "").toISOString(),
    );
  });

  it("memoises, so one build cannot observe two different instants", () => {
    const first = buildNow();
    const second = buildNow();
    expect(first).toBe(second);
  });
});
