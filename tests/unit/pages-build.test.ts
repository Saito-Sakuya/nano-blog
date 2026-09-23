import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertPagesEnvironment,
  pullPagesRuntime,
} from "../../scripts/build/build";
import { EXIT } from "../../scripts/lib/errors";
import type { SourceRecord } from "../../src/lib/content/source-record";

const R2_SOURCE: SourceRecord = {
  schemaVersion: 1,
  mode: "r2",
  releaseId: "20260915T000000Z-0123456789ab",
  contentDigest: `sha256:${"0".repeat(64)}`,
  materializedAt: "2026-09-15T00:00:00.000Z",
  offline: false,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

function pagesEnvironment(kind: "production" | "preview" = "preview"): void {
  vi.stubEnv("SITE_ENV", kind);
  vi.stubEnv("SITE_URL", "https://preview.example.test");
  vi.stubEnv("PUBLIC_MEDIA_ORIGIN", "https://media.example.test");
}

describe("Pages build environment", () => {
  it.each(["production", "preview"] as const)(
    "accepts explicit HTTPS origins in %s",
    (kind) => {
      pagesEnvironment(kind);
      expect(() => assertPagesEnvironment()).not.toThrow();
    },
  );

  it.each([
    ["SITE_URL", "http://blog.example.test"],
    ["SITE_URL", "https://user:password@blog.example.test"],
    ["SITE_URL", "https://blog.example.test/articles"],
    ["SITE_URL", "https://blog.example.test?preview=1"],
    ["PUBLIC_MEDIA_ORIGIN", "https://media.example.test/assets"],
  ])("rejects a non-origin %s value", (name, value) => {
    pagesEnvironment();
    vi.stubEnv(name, value);
    expect(() => assertPagesEnvironment()).toThrow(new RegExp(name, "u"));
  });
});

describe("pullPagesRuntime", () => {
  it("requires a successful pull and a complete R2 source record", async () => {
    const pull = vi.fn(async () => EXIT.OK);
    const readSource = vi.fn(() => R2_SOURCE);

    await expect(pullPagesRuntime({ pull, readSource })).resolves.toEqual(
      R2_SOURCE,
    );
    expect(pull).toHaveBeenCalledOnce();
    expect(readSource).toHaveBeenCalledOnce();
  });

  it("does not accept a stale runtime when the pull command fails", async () => {
    const readSource = vi.fn(() => R2_SOURCE);
    await expect(
      pullPagesRuntime({
        pull: async () => EXIT.VALIDATION,
        readSource,
      }),
    ).rejects.toThrow(/exited with code 3/u);
    expect(readSource).not.toHaveBeenCalled();
  });

  it("rejects a successful command that did not produce an R2 runtime", async () => {
    await expect(
      pullPagesRuntime({
        pull: async () => EXIT.OK,
        readSource: () => ({ ...R2_SOURCE, mode: "workspace" }),
      }),
    ).rejects.toThrow(/no complete R2 source record/u);
  });
});
