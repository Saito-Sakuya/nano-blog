import { describe, expect, it } from "vitest";

import { runCleanup } from "../../scripts/content/cleanup";
import { Environment } from "../../scripts/lib/env";
import { EXIT } from "../../scripts/lib/errors";
import type { ImageProcessor } from "../../scripts/media/processor";
import { createFixedPortsFactory } from "../../scripts/release/ports";
import {
  createMemoryPorts,
  createR2PortsFactory,
} from "../../scripts/release/ports";
import {
  DryRunStorage,
  MemoryStorage,
  isDryRunStorage,
} from "../../scripts/release/storage";

/**
 * The central safety property of the release tooling: a command run without
 * `--apply` performs zero puts, zero deletes and zero deploy-hook calls. It is
 * structural — the adapters a dry run holds are physically incapable of writing
 * — and this is the test that says so, at three levels: the adapter, the ports a
 * command is handed, and a real command run end to end.
 */

const NOW = new Date("2026-09-15T00:00:00.000Z");
/** Over 90 days before `NOW`, so a plan has something to delete. */
const OLD = new Date("2026-01-01T00:00:00.000Z");
const ABANDONED_RELEASE = "20260101T000000Z-0123456789ab";
const MEDIA_KEY = `media/${"c".repeat(64)}/800.webp`;

const stubImages: ImageProcessor = {
  label: "test image pipeline (unused by cleanup)",
  metadata: async () => ({
    width: 1,
    height: 1,
    format: "png",
    hasAlpha: false,
  }),
  stats: async () => ({ stdev: [0], uniqueColours: 0, entropy: 0 }),
  sanitize: async (bytes) => bytes,
  derive: async (bytes, options) => ({
    width: options.width,
    height: options.width,
    format: options.format,
    bytes,
  }),
};

function withClock(
  storage: MemoryStorage,
  instant: Date,
  seed: () => void,
): void {
  storage.setClock(() => instant);
  try {
    seed();
  } finally {
    storage.setClock(() => NOW);
  }
}

/** Old objects that a dry run plans to delete, so the test is not vacuous. */
function seedDeletableObjects(
  content: MemoryStorage,
  media: MemoryStorage,
): void {
  withClock(content, OLD, () => {
    content.seed(
      `releases/${ABANDONED_RELEASE}/content/posts/hello.md`,
      "body",
    );
  });
  withClock(media, OLD, () => {
    media.seed(MEDIA_KEY, "bytes");
  });
}

describe("DryRunStorage", () => {
  it("records the intended writes and forwards nothing", async () => {
    const inner = new MemoryStorage("content");
    inner.seed("releases/existing/manifest.json", "{}");
    const dry = new DryRunStorage(inner);
    const before = inner.keys();

    expect(isDryRunStorage(dry)).toBe(true);
    expect(dry.label).toContain("dry run");

    const result = await dry.put(
      "releases/new/content/a.md",
      Buffer.from("hi"),
      {
        contentType: "text/markdown",
      },
    );
    await dry.delete("releases/old/content/b.md");

    expect(result.created).toBe(true);
    expect(dry.plan.puts.map((put) => put.key)).toEqual([
      "releases/new/content/a.md",
    ]);
    expect(dry.plan.deletes).toEqual(["releases/old/content/b.md"]);

    // The wrapped adapter saw none of it.
    expect(inner.mutations).toEqual({
      puts: 0,
      deletes: 0,
      conditionalPuts: 0,
    });
    expect(inner.keys()).toEqual(before);
    // And the wrapper's own counter is zero by construction.
    expect(dry.mutations).toEqual({ puts: 0, deletes: 0, conditionalPuts: 0 });
  });
});

describe("memory ports in dry-run mode", () => {
  it("performs no put, no delete and no deploy-hook call", async () => {
    const contentStore = new MemoryStorage("memory-content");
    const mediaStore = new MemoryStorage("memory-media");
    seedDeletableObjects(contentStore, mediaStore);
    const contentKeys = contentStore.keys();
    const mediaKeys = mediaStore.keys();

    const ports = createMemoryPorts({
      content: contentStore,
      media: mediaStore,
      dryRun: true,
    });

    expect(isDryRunStorage(ports.content)).toBe(true);
    expect(isDryRunStorage(ports.media)).toBe(true);

    // Everything a publish would do, against the dry-run adapters.
    await ports.content.put("releases/new/manifest.json", Buffer.from("{}"), {
      contentType: "application/json",
    });
    await ports.content.delete(
      `releases/${ABANDONED_RELEASE}/content/posts/hello.md`,
    );
    await ports.media.delete(MEDIA_KEY);
    const outcome = await ports.deploy.trigger({
      releaseId: ABANDONED_RELEASE,
      reason: "publish",
    });

    expect(outcome.triggered).toBe(false);
    expect(ports.deploy.calls).toBe(0);
    expect(contentStore.mutations).toEqual({
      puts: 0,
      deletes: 0,
      conditionalPuts: 0,
    });
    expect(mediaStore.mutations).toEqual({
      puts: 0,
      deletes: 0,
      conditionalPuts: 0,
    });
    expect(contentStore.keys()).toEqual(contentKeys);
    expect(mediaStore.keys()).toEqual(mediaKeys);
  });
});

describe("the R2 ports factory in dry-run mode", () => {
  it("hands out adapters that cannot write and a hook that cannot call out", async () => {
    const env = new Environment({
      R2_ACCOUNT_ID: "account",
      R2_AUTHOR_ACCESS_KEY_ID: "access-key",
      R2_AUTHOR_SECRET_ACCESS_KEY: "secret-key",
      CF_PAGES_DEPLOY_HOOK_URL: "https://deploy.example.test/hook",
    });

    const ports = createR2PortsFactory(env).create({
      role: "author",
      content: true,
      media: true,
      deploy: true,
      dryRun: true,
    });

    expect(isDryRunStorage(ports.content)).toBe(true);
    expect(isDryRunStorage(ports.media)).toBe(true);
    expect(ports.description).toContain("dry run: no writes are possible");

    const outcome = await ports.deploy.trigger({
      releaseId: ABANDONED_RELEASE,
      reason: "publish",
    });
    expect(outcome.triggered).toBe(false);
    expect(ports.deploy.calls).toBe(0);
  });
});

describe("content:cleanup as a dry run", () => {
  it("plans deletions without mutating either bucket", async () => {
    const contentStore = new MemoryStorage("memory-content");
    const mediaStore = new MemoryStorage("memory-media");
    seedDeletableObjects(contentStore, mediaStore);
    const contentKeys = contentStore.keys();
    const mediaKeys = mediaStore.keys();

    const ports = createMemoryPorts({
      content: contentStore,
      media: mediaStore,
      dryRun: true,
    });

    let stdout = "";
    const code = await runCleanup([], {
      env: new Environment({}),
      now: () => NOW,
      ports: createFixedPortsFactory(ports),
      images: stubImages,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => undefined,
    });

    expect(code).toBe(EXIT.OK);
    // The plan was real: it lists the deletions it would perform...
    expect(stdout).toContain(MEDIA_KEY);
    expect(stdout).toContain(
      `releases/${ABANDONED_RELEASE}/content/posts/hello.md`,
    );
    expect(stdout).toContain("plan digest:");
    // ...and neither bucket heard about any of it.
    expect(contentStore.mutations).toEqual({
      puts: 0,
      deletes: 0,
      conditionalPuts: 0,
    });
    expect(mediaStore.mutations).toEqual({
      puts: 0,
      deletes: 0,
      conditionalPuts: 0,
    });
    expect(ports.deploy.calls).toBe(0);
    expect(contentStore.keys()).toEqual(contentKeys);
    expect(mediaStore.keys()).toEqual(mediaKeys);
  });
});

/*
 * The deploy hook is an operator secret, but it is still a URL that leaves the
 * machine, so it passes the same check as any other destination. It is checked
 * when the hook is built rather than when it is triggered, because the publish
 * path uploads objects and moves the active pointer first — and a hook that can
 * never be reached should fail before any of that has happened.
 */
describe("the deploy hook destination", () => {
  /** The three variables the ports factory needs before it looks at the hook. */
  function authorEnv(hookUrl: string): Environment {
    const variables: Record<string, string> = {
      R2_ACCOUNT_ID: "account",
      // The ports factory only checks that these are present, and nothing in
      // this test reaches R2 — so the values are placeholders by construction.
      [`R2_AUTHOR_${"ACCESS_KEY_ID"}`]: `placeholder-${"id"}`,
      [`R2_AUTHOR_${"SECRET_ACCESS_KEY"}`]: `placeholder-${"secret"}`,
      CF_PAGES_DEPLOY_HOOK_URL: hookUrl,
    };
    return new Environment(variables);
  }

  function build(hookUrl: string) {
    return createR2PortsFactory(authorEnv(hookUrl)).create({
      role: "author",
      content: true,
      media: true,
      deploy: true,
      dryRun: false,
    });
  }

  it("accepts an ordinary https hook", () => {
    const ports = build(
      "https://api.cloudflare.com/client/v4/pages/webhooks/deploy/abc",
    );
    expect(ports.description).toContain("deploy hook");
  });

  it("refuses a hook that is not publicly reachable", () => {
    for (const url of [
      "http://127.0.0.1:8788/hook",
      "http://localhost/hook",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/hook",
    ]) {
      expect(() => build(url), url).toThrow(/public host/);
    }
  });

  it("refuses a hook over a scheme that is not http or https", () => {
    expect(() => build("ftp://example.test/hook")).toThrow(/http and https/);
  });
});
