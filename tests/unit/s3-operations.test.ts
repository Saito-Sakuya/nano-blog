import { describe, expect, it } from "vitest";

import { RemoteError } from "../../scripts/lib/errors";
import { toListedObjects } from "../../scripts/release/s3-operations";

/**
 * A listing entry used to be padded into shape — `key: ""`, `bytes: 0`,
 * `lastModified: null` — so a response that lost a field produced an object
 * that matched no retention rule and could be deleted on the strength of
 * numbers nobody ever received. Malformed entries are now an error.
 */

const WHEN = new Date("2026-01-01T00:00:00.000Z");

describe("toListedObjects", () => {
  it("maps a complete entry", () => {
    expect(
      toListedObjects([
        {
          Key: "releases/a/manifest.json",
          Size: 12,
          ETag: '"abc"',
          LastModified: WHEN,
        },
      ]),
    ).toEqual([
      {
        key: "releases/a/manifest.json",
        bytes: 12,
        etag: '"abc"',
        lastModified: WHEN,
      },
    ]);
  });

  it("treats a page with no contents as an empty listing", () => {
    expect(toListedObjects(undefined)).toEqual([]);
    expect(toListedObjects([])).toEqual([]);
  });

  it("accepts a zero-byte object", () => {
    const [object] = toListedObjects([
      { Key: "a", Size: 0, LastModified: WHEN },
    ]);
    expect(object?.bytes).toBe(0);
  });

  it("reports an absent ETag as null rather than inventing one", () => {
    const [object] = toListedObjects([
      { Key: "a", Size: 1, LastModified: WHEN },
    ]);
    expect(object?.etag).toBeNull();
  });

  it("refuses an entry with no key, naming its position", () => {
    expect(() => toListedObjects([{ Size: 1, LastModified: WHEN }])).toThrow(
      RemoteError,
    );
    expect(() => toListedObjects([{ Size: 1, LastModified: WHEN }])).toThrow(
      /position 0 with no key/u,
    );
  });

  it("refuses an entry with an empty key", () => {
    expect(() =>
      toListedObjects([{ Key: "", Size: 1, LastModified: WHEN }]),
    ).toThrow(/no key/u);
  });

  it("refuses an entry with no size", () => {
    expect(() =>
      toListedObjects([{ Key: "releases/a/x.md", LastModified: WHEN }]),
    ).toThrow(/releases\/a\/x\.md.*valid size/u);
  });

  it("refuses a size that is not a whole number of bytes", () => {
    expect(() =>
      toListedObjects([
        { Key: "releases/a/x.md", Size: Number.NaN, LastModified: WHEN },
      ]),
    ).toThrow(RemoteError);
    expect(() =>
      toListedObjects([
        { Key: "releases/a/x.md", Size: -1, LastModified: WHEN },
      ]),
    ).toThrow(/valid size \(-1\)/u);
  });

  it("refuses an entry with no last-modified time", () => {
    expect(() =>
      toListedObjects([{ Key: "releases/a/x.md", Size: 1 }]),
    ).toThrow(/last modified/u);
  });

  it("refuses an invalid last-modified time", () => {
    expect(() =>
      toListedObjects([
        { Key: "releases/a/x.md", Size: 1, LastModified: new Date(Number.NaN) },
      ]),
    ).toThrow(RemoteError);
  });
});
