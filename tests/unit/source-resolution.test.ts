import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  FIXTURE_CONTENT_DIR,
  resolveLocalSource,
} from "../../scripts/content/load";

/**
 * Which content source a local command reads.
 *
 * `--source <kind>` is how a caller says "check the fixtures, not my
 * workspace". The flag has documented choices and the commands pass it
 * through, so a kind that silently falls back to the auto-detected source is a
 * command reporting on content nobody asked about.
 */

describe("resolveLocalSource — an explicit kind", () => {
  it("reads the checked-in fixtures for --source fixtures", async () => {
    const resolved = await resolveLocalSource({ kind: "fixtures" });

    expect(resolved.kind).toBe("fixtures");
    expect(resolved.root).toBe(FIXTURE_CONTENT_DIR);
    expect(existsSync(resolved.root)).toBe(true);
  });

  it("does not fall back to the workspace when a kind was named", async () => {
    // The worktree has a workspace only when an author created one; this
    // assertion is about the kind surviving the call, not about which
    // directories exist.
    const resolved = await resolveLocalSource({ kind: "fixtures" });
    expect(resolved.kind).not.toBe("workspace");
    expect(resolved.label).not.toBe("author workspace");
  });

  it("refuses --source directory without --path", async () => {
    await expect(resolveLocalSource({ kind: "directory" })).rejects.toThrow(
      /--path/u,
    );
  });
});

describe("resolveLocalSource — an explicit path", () => {
  it("reads the directory it was given", async () => {
    const resolved = await resolveLocalSource({
      root: "tests/fixtures/content",
    });

    expect(resolved.kind).toBe("directory");
    expect(resolved.root).toBe(FIXTURE_CONTENT_DIR);
  });

  it("keeps a kind that was given alongside the path", async () => {
    const resolved = await resolveLocalSource({
      kind: "fixtures",
      root: "tests/fixtures/content",
    });

    expect(resolved.kind).toBe("fixtures");
    expect(resolved.root).toBe(FIXTURE_CONTENT_DIR);
  });
});
