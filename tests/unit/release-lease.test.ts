import { describe, expect, it } from "vitest";

import { ConflictError } from "../../scripts/lib/errors";
import {
  MUTATION_LEASE_KEY,
  acquireMutationLease,
} from "../../scripts/release/lease";
import { MemoryStorage } from "../../scripts/release/storage";

describe("release mutation lease", () => {
  it("allows only one live holder and can be acquired after release", async () => {
    const storage = new MemoryStorage("content");
    const now = () => new Date("2026-09-22T00:00:00.000Z");
    const first = await acquireMutationLease({
      storage,
      operation: "publish",
      owner: "publisher-a",
      now,
      ttlMs: 60_000,
      renewWindowMs: 10_000,
    });

    await expect(
      acquireMutationLease({
        storage,
        operation: "rollback",
        owner: "rollback-b",
        now,
        ttlMs: 60_000,
        renewWindowMs: 10_000,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    await first.release();
    const second = await acquireMutationLease({
      storage,
      operation: "rollback",
      owner: "rollback-b",
      now,
      ttlMs: 60_000,
      renewWindowMs: 10_000,
    });

    expect(second.owner).toBe("rollback-b");
    expect(await storage.head(MUTATION_LEASE_KEY)).not.toBeNull();
    await second.release();
  });

  it("does not let an expired holder release a newer holder's lease", async () => {
    const storage = new MemoryStorage("content");
    let instant = new Date("2026-09-22T00:00:00.000Z");
    const now = () => instant;
    const first = await acquireMutationLease({
      storage,
      operation: "publish",
      owner: "publisher-a",
      now,
      ttlMs: 1_000,
      renewWindowMs: 200,
    });

    instant = new Date("2026-09-22T00:00:02.000Z");
    const second = await acquireMutationLease({
      storage,
      operation: "cleanup",
      owner: "cleanup-b",
      now,
      ttlMs: 1_000,
      renewWindowMs: 200,
    });

    await expect(first.release()).rejects.toBeInstanceOf(ConflictError);
    await expect(
      acquireMutationLease({
        storage,
        operation: "rollback",
        owner: "rollback-c",
        now,
        ttlMs: 1_000,
        renewWindowMs: 200,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    await second.release();
  });

  it("renews with CAS before the expiry window closes", async () => {
    const storage = new MemoryStorage("content");
    let instant = new Date("2026-09-22T00:00:00.000Z");
    const now = () => instant;
    const lease = await acquireMutationLease({
      storage,
      operation: "cleanup",
      owner: "cleanup-a",
      now,
      ttlMs: 1_000,
      renewWindowMs: 250,
    });

    instant = new Date("2026-09-22T00:00:00.800Z");
    await lease.renewIfNeeded();
    expect(lease.record.expiresAt).toBe("2026-09-22T00:00:01.800Z");

    instant = new Date("2026-09-22T00:00:01.200Z");
    await expect(
      acquireMutationLease({
        storage,
        operation: "publish",
        owner: "publisher-b",
        now,
        ttlMs: 1_000,
        renewWindowMs: 250,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    await lease.release();
  });
});
