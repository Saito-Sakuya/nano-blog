import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SourceRecordError,
  readSourceRecordFrom,
} from "../../src/lib/content/source-record";

/**
 * The record of where a build's content came from.
 *
 * Two states must stay distinguishable. A missing file is "nothing was
 * materialised" and renders no banner. A file that exists but cannot be
 * believed is a failure: the fixture and offline banners exist so a reader is
 * never shown test content, or an unverified cache, as though it were the real
 * site, and a reader that quietly returns `null` for a damaged record would
 * drop exactly that warning.
 */

let directory: string;

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "source-record-"));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

let counter = 0;

/** Write a record file and return its path. */
function recordFile(contents: string): string {
  counter += 1;
  const file = path.join(directory, `source-${counter}.json`);
  writeFileSync(file, contents, "utf8");
  return file;
}

function validRecord(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mode: "fixtures",
    releaseId: null,
    contentDigest: null,
    materializedAt: "2026-09-15T08:00:00.000Z",
    offline: false,
  };
}

describe("readSourceRecordFrom — not materialised", () => {
  it("returns null when the file does not exist", () => {
    expect(
      readSourceRecordFrom(path.join(directory, "absent.json")),
    ).toBeNull();
  });
});

describe("readSourceRecordFrom — a believable record", () => {
  it("reads every field", () => {
    const file = recordFile(
      JSON.stringify({
        ...validRecord(),
        mode: "r2",
        releaseId: "2026-09-15-abcdef",
        contentDigest: "a".repeat(64),
        offline: true,
      }),
    );

    expect(readSourceRecordFrom(file)).toEqual({
      schemaVersion: 1,
      mode: "r2",
      releaseId: "2026-09-15-abcdef",
      contentDigest: "a".repeat(64),
      materializedAt: "2026-09-15T08:00:00.000Z",
      offline: true,
    });
  });

  it("defaults schemaVersion and the nullable fields", () => {
    const file = recordFile(
      JSON.stringify({
        mode: "empty",
        materializedAt: "2026-09-15T08:00:00.000Z",
      }),
    );

    const record = readSourceRecordFrom(file);
    expect(record?.schemaVersion).toBe(1);
    expect(record?.releaseId).toBeNull();
    expect(record?.contentDigest).toBeNull();
    expect(record?.offline).toBe(false);
  });
});

describe("readSourceRecordFrom — a damaged record", () => {
  it("refuses a mode that is not one of the four", () => {
    // `"r2x"` used to be cast to the enum and handed back as a valid mode.
    const file = recordFile(JSON.stringify({ ...validRecord(), mode: "r2x" }));
    expect(() => readSourceRecordFrom(file)).toThrow(SourceRecordError);
    expect(() => readSourceRecordFrom(file)).toThrow(/not one of/u);
  });

  it("refuses a missing mode", () => {
    const file = recordFile(
      JSON.stringify({
        materializedAt: "2026-09-15T08:00:00.000Z",
      }),
    );
    expect(() => readSourceRecordFrom(file)).toThrow(SourceRecordError);
  });

  it("refuses an empty or unparsable materializedAt", () => {
    // `materializedAt ?? ""` put an empty string into `Intl`, where it becomes
    // a RangeError far from the record that caused it.
    for (const materializedAt of ["", "yesterday", 17, null]) {
      const file = recordFile(
        JSON.stringify({ ...validRecord(), materializedAt }),
      );
      expect(() => readSourceRecordFrom(file), String(materializedAt)).toThrow(
        /materializedAt/u,
      );
    }
  });

  it("refuses a malformed releaseId", () => {
    const file = recordFile(
      JSON.stringify({ ...validRecord(), releaseId: 42 }),
    );
    expect(() => readSourceRecordFrom(file)).toThrow(/releaseId/u);
  });

  it("refuses a schemaVersion that is not a number", () => {
    const file = recordFile(
      JSON.stringify({ ...validRecord(), schemaVersion: "1" }),
    );
    expect(() => readSourceRecordFrom(file)).toThrow(/schemaVersion/u);
  });

  it("refuses JSON that is not an object", () => {
    for (const contents of ["[]", "null", '"a string"', "{ not json"]) {
      const file = recordFile(contents);
      expect(() => readSourceRecordFrom(file), contents).toThrow(
        SourceRecordError,
      );
    }
  });
});
