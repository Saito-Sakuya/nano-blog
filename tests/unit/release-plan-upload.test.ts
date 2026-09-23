import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConflictError } from "../../scripts/lib/errors";
import {
  buildReleasePlan,
  uploadRelease,
} from "../../scripts/release/release-plan";
import { MemoryStorage } from "../../scripts/release/storage";

const roots: string[] = [];

async function contentDirectory(body: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nano-release-plan-"));
  roots.push(root);
  const content = path.join(root, "content");
  await mkdir(path.join(content, "posts"), { recursive: true });
  await writeFile(path.join(content, "posts", "hello.md"), body, "utf8");
  return content;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("uploadRelease local snapshot", () => {
  it("checks the lease before each content object and the manifest", async () => {
    const content = await contentDirectory("# stable\n");
    const plan = await buildReleasePlan({
      contentDir: content,
      baseReleaseId: null,
      createdAt: new Date("2026-09-22T00:00:00.000Z"),
    });
    const storage = new MemoryStorage("content");
    let checks = 0;

    await uploadRelease(plan, storage, {
      cacheControl: "immutable",
      beforeObject: async () => {
        checks += 1;
      },
    });

    expect(checks).toBe(plan.files.length + 1);
  });

  it("refuses a file that changed after the release plan was built", async () => {
    const content = await contentDirectory("# before\n");
    const plan = await buildReleasePlan({
      contentDir: content,
      baseReleaseId: null,
      createdAt: new Date("2026-09-22T00:00:00.000Z"),
    });
    await writeFile(
      path.join(content, "posts", "hello.md"),
      "# after!\n",
      "utf8",
    );

    const storage = new MemoryStorage("content");
    await expect(
      uploadRelease(plan, storage, { cacheControl: "immutable" }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(storage.keys()).toEqual([]);
  });
});
