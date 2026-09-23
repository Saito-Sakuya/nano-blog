import { describe, expect, it } from "vitest";

import {
  DeployFailedError,
  HttpDeployHook,
} from "../../scripts/release/deploy";

const TRIGGER = {
  releaseId: "20260922T000000Z-0123456789ab",
  reason: "publish" as const,
};

describe("HttpDeployHook", () => {
  it("aborts a hung attempt at the timeout and retries a bounded number of times", async () => {
    const sleeps: number[] = [];
    const hook = new HttpDeployHook({
      url: "https://deploy.example.test/hook",
      timeoutMs: 5,
      maxTries: 2,
      retry: {
        random: () => 0,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null) {
            reject(new Error("missing AbortSignal"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    });

    const error = await hook
      .trigger(TRIGGER)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DeployFailedError);
    expect(error).toMatchObject({
      name: "DeployFailedError",
      releaseId: TRIGGER.releaseId,
    });
    expect(String(error)).toContain("timed out after 5 ms");
    expect(hook.calls).toBe(2);
    expect(sleeps).toEqual([250]);
  });

  it("does not retry a permanent 4xx response", async () => {
    const hook = new HttpDeployHook({
      url: "https://deploy.example.test/hook",
      maxTries: 3,
      fetch: () => Promise.resolve(new Response(null, { status: 400 })),
    });

    await expect(hook.trigger(TRIGGER)).rejects.toBeInstanceOf(
      DeployFailedError,
    );
    expect(hook.calls).toBe(1);
  });

  it("reports a 2xx response as an accepted trigger request", async () => {
    let body = "";
    const hook = new HttpDeployHook({
      url: "https://deploy.example.test/hook",
      fetch: (_input, init) => {
        body = String(init?.body ?? "");
        return Promise.resolve(new Response(null, { status: 202 }));
      },
    });

    await expect(hook.trigger(TRIGGER)).resolves.toEqual({
      triggered: true,
      status: 202,
      attempts: 1,
    });
    expect(JSON.parse(body)).toEqual(TRIGGER);
  });
});
