import { SITE_ENV, SITE_TIME_ZONE, type SiteEnv } from "../site.js";

/**
 * The single instant a build treats as "now".
 *
 * Every visibility decision — which posts are public, whether a future-dated
 * article appears, what the archive cuts off at — reads this one value. Reading
 * the clock once means a long build cannot publish an article halfway through
 * itself, and it lets the test suite pin time by setting `BUILD_NOW`.
 *
 * `BUILD_NOW` is a test fixture, not a deployment control, so it is refused in a
 * production build and validated when it is accepted: a leftover pin freezes
 * the whole site's idea of "now", and a pin that was not meant to be there is
 * far more likely to be a typo than a deliberate date.
 */

let cached: Date | undefined;

/**
 * A strict ISO 8601 instant with an explicit UTC offset.
 *
 * `new Date()` accepts far more than that — `"2026"`, `"5/1/2026"` and
 * `"March 3 2026"` are all parsed, in the host's locale and zone — so the text
 * is checked before it is trusted.
 */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * How far a pin may sit from the real clock.
 *
 * Deliberately loose: the point is to catch a century-scale typo (`2062` for
 * `2026`), not to invalidate a test fixture as the calendar moves on from the
 * date it was written. Anything closer than this is taken at face value.
 */
const MAX_PIN_DISTANCE_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/**
 * Validate a `BUILD_NOW` value.
 *
 * Exported separately from `buildNow` so the rules can be tested without
 * setting process state, and so a caller that already knows the environment can
 * ask the same question.
 */
export function parseBuildNowPin(
  raw: string,
  options: { readonly siteEnv: SiteEnv; readonly now: Date },
): Date {
  if (options.siteEnv === "production") {
    throw new Error(
      "BUILD_NOW is a test-only clock pin and is not allowed in a production build (SITE_ENV=production); remove it and let the build read the real clock.",
    );
  }

  if (!ISO_INSTANT.test(raw)) {
    throw new Error(
      `BUILD_NOW must be a strict ISO 8601 instant with an explicit UTC offset (for example 2026-09-15T00:00:00Z), but received ${JSON.stringify(raw)}.`,
    );
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`BUILD_NOW is not a real instant: ${JSON.stringify(raw)}.`);
  }

  const distance = Math.abs(parsed.getTime() - options.now.getTime());
  if (distance > MAX_PIN_DISTANCE_MS) {
    throw new Error(
      `BUILD_NOW (${raw}) is ${Math.round(distance / (24 * 60 * 60 * 1000))} days away from the current time, which is too far to be a deliberate pin.`,
    );
  }

  return parsed;
}

export function buildNow(): Date {
  if (cached !== undefined) return cached;

  const raw = process.env["BUILD_NOW"];
  if (raw === undefined || raw === "") {
    cached = new Date();
    return cached;
  }

  cached = parseBuildNowPin(raw, { siteEnv: SITE_ENV, now: new Date() });
  return cached;
}

/** Reset the memoised clock. Test-only. */
export function resetBuildNow(): void {
  cached = undefined;
}

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SITE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dateTimeFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: SITE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * `YYYY-MM-DD` in the site time zone. The site's own time zone decides the
 * calendar day, so an article published late in the evening in Taipei does not
 * show yesterday's date because the build machine sits in UTC.
 */
export function displayDate(iso: string): string {
  return dateFormatter.format(new Date(iso));
}

/** `YYYY-MM-DD HH:mm` in the site time zone, for machine-adjacent contexts. */
export function displayDateTime(iso: string): string {
  return dateTimeFormatter.format(new Date(iso));
}

/** The calendar year of an instant, in the site time zone. */
export function yearOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SITE_TIME_ZONE,
    year: "numeric",
  }).format(new Date(iso));
}

/** The calendar month (01–12) of an instant, in the site time zone. */
export function monthOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SITE_TIME_ZONE,
    month: "2-digit",
  }).format(new Date(iso));
}
