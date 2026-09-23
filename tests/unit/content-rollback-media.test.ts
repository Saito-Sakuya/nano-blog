import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runRollback } from "../../scripts/content/rollback";
import { Environment } from "../../scripts/lib/env";
import { EXIT } from "../../scripts/lib/errors";
import type { ImageProcessor } from "../../scripts/media/processor";
import {
  ACTIVE_KEY,
  buildActivePointer,
  readActive,
  serializeActivePointer,
} from "../../scripts/release/active";
import type {
  DeployHook,
  DeployOutcome,
  DeployTrigger,
} from "../../scripts/release/deploy";
import { sha256Hex } from "../../scripts/release/digest";
import {
  MARKDOWN_CONTENT_TYPE,
  buildManifest,
  contentObjectKey,
  manifestObjectKey,
} from "../../scripts/release/manifest";
import {
  createFixedPortsFactory,
  createMemoryPorts,
  type MemoryPorts,
} from "../../scripts/release/ports";
import { MemoryStorage } from "../../scripts/release/storage";

const NOW = new Date("2026-09-22T00:00:00.000Z");
const BODY = "# rollback target\n";
const ORIGINAL = Buffer.from("verified original", "utf8");
const VARIANT = Buffer.from("verified cover", "utf8");
const DIGEST = "d".repeat(64);
const ORIGINAL_PATH = `/media/${DIGEST}/original.png`;
const VARIANT_PATH = `/media/${DIGEST}/1600.webp`;

const roots: string[] = [];

const images: ImageProcessor = {
  label: "unused rollback image processor",
  sanitize: async (bytes) => bytes,
  metadata: async () => ({
    width: 1,
    height: 1,
    format: "png",
    hasAlpha: false,
  }),
  stats: async () => ({ stdev: [0], uniqueColours: 0, entropy: 0 }),
  derive: async (bytes, options) => ({
    width: options.width,
    height: options.width,
    format: options.format,
    bytes,
  }),
};

class CountingDeployHook implements DeployHook {
  readonly label = "test deploy hook";
  calls = 0;
  readonly triggers: DeployTrigger[] = [];

  trigger(trigger: DeployTrigger): Promise<DeployOutcome> {
    this.calls += 1;
    this.triggers.push(trigger);
    return Promise.resolve({ triggered: true, status: 202, attempts: 1 });
  }
}

interface Fixture {
  readonly ports: MemoryPorts;
  readonly deploy: CountingDeployHook;
  readonly releaseId: string;
  readonly currentReleaseId: string;
}

function seedFixture(
  options: {
    readonly damagedMedia?: boolean;
    readonly targetAlreadyActive?: boolean;
  } = {},
): Fixture {
  const content = new MemoryStorage("content");
  const media = new MemoryStorage("media");
  const deploy = new CountingDeployHook();

  const target = buildManifest({
    createdAt: NOW,
    baseReleaseId: null,
    files: [
      {
        path: "posts/rollback-target.md",
        sha256: sha256Hex(BODY),
        bytes: Buffer.byteLength(BODY, "utf8"),
        contentType: MARKDOWN_CONTENT_TYPE,
      },
    ],
    media: [{ path: VARIANT_PATH, sha256: DIGEST }],
  });
  content.seed(manifestObjectKey(target.releaseId), JSON.stringify(target));
  content.seed(
    contentObjectKey(target.releaseId, "posts/rollback-target.md"),
    BODY,
  );

  const current = buildManifest({
    createdAt: new Date("2026-09-21T00:00:00.000Z"),
    baseReleaseId: null,
    files: [],
    media: [],
  });
  const activeManifest = options.targetAlreadyActive ? target : current;
  content.seed(
    ACTIVE_KEY,
    serializeActivePointer(
      buildActivePointer({
        releaseId: activeManifest.releaseId,
        contentDigest: activeManifest.contentDigest,
        instant: NOW,
      }),
    ),
  );

  const meta = {
    schemaVersion: 1,
    sourceSha256: DIGEST,
    mimeType: "image/png",
    kind: "image",
    alt: "Rollback media fixture",
    license: "CC-BY-4.0",
    original: {
      path: ORIGINAL_PATH,
      width: 1600,
      height: 900,
      bytes: ORIGINAL.byteLength,
      sha256: sha256Hex(ORIGINAL),
      format: "png",
    },
    variants: [
      {
        path: VARIANT_PATH,
        width: 1600,
        height: 900,
        bytes: VARIANT.byteLength,
        sha256: sha256Hex(VARIANT),
        format: "webp",
      },
    ],
    createdAt: NOW.toISOString(),
  };
  media.seed(`media/${DIGEST}/meta.json`, JSON.stringify(meta));
  media.seed(`media/${DIGEST}/original.png`, ORIGINAL);
  media.seed(
    `media/${DIGEST}/1600.webp`,
    options.damagedMedia
      ? Buffer.from("x".repeat(VARIANT.byteLength), "utf8")
      : VARIANT,
  );

  return {
    ports: createMemoryPorts({ content, media, deploy, dryRun: false }),
    deploy,
    releaseId: target.releaseId,
    currentReleaseId: activeManifest.releaseId,
  };
}

async function run(
  fixture: Fixture,
  argv: readonly string[],
): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "rollback-media-"));
  roots.push(cacheRoot);
  let stdout = "";
  let stderr = "";
  const code = await runRollback(
    argv,
    {
      env: new Environment({}),
      now: () => NOW,
      ports: createFixedPortsFactory(fixture.ports),
      images,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    { cacheRoot },
  );
  return { code, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("content:rollback media verification", () => {
  it("verifies media during dry-run even when the target is already active", async () => {
    const fixture = seedFixture({
      damagedMedia: true,
      targetAlreadyActive: true,
    });
    const before = await fixture.ports.contentStore.get(ACTIVE_KEY);

    const result = await run(fixture, ["--release", fixture.releaseId]);

    expect(result.code).toBe(EXIT.VALIDATION);
    expect(result.stderr).toContain("hashes to");
    expect(fixture.deploy.calls).toBe(0);
    expect(fixture.ports.contentStore.mutations.puts).toBe(0);
    const after = await fixture.ports.contentStore.get(ACTIVE_KEY);
    expect(after.bytes).toEqual(before.bytes);
  });

  it("does not activate or deploy when referenced media is damaged", async () => {
    const fixture = seedFixture({ damagedMedia: true });

    const result = await run(fixture, [
      "--release",
      fixture.releaseId,
      "--apply",
    ]);

    expect(result.code).toBe(EXIT.VALIDATION);
    expect(
      (await readActive(fixture.ports.contentStore)).pointer?.releaseId,
    ).toBe(fixture.currentReleaseId);
    expect(fixture.deploy.calls).toBe(0);
  });

  it("reports content and media object/byte summaries in a successful dry-run", async () => {
    const fixture = seedFixture();

    const result = await run(fixture, ["--release", fixture.releaseId]);

    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain("1 content object(s)");
    expect(result.stdout).toContain("3 media object(s), including records");
    expect(result.stdout).toContain("verified bytes: content");
    expect(result.stdout).toContain("media");
    expect(
      (await readActive(fixture.ports.contentStore)).pointer?.releaseId,
    ).toBe(fixture.currentReleaseId);
    expect(fixture.deploy.calls).toBe(0);
    expect(fixture.ports.contentStore.mutations.puts).toBe(0);
  });

  it("activates and requests a deploy only after content and media verify", async () => {
    const fixture = seedFixture();

    const result = await run(fixture, [
      "--release",
      fixture.releaseId,
      "--apply",
    ]);

    expect(result.code).toBe(EXIT.OK);
    expect(
      (await readActive(fixture.ports.contentStore)).pointer?.releaseId,
    ).toBe(fixture.releaseId);
    expect(fixture.deploy.triggers).toEqual([
      { releaseId: fixture.releaseId, reason: "rollback" },
    ]);
  });
});
