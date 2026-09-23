import { assertFetchableOrigin } from "../../functions/lib/outbound-url.js";
import { currentEnvironment, type Environment } from "../lib/env.js";
import { CredentialsError, UsageError } from "../lib/errors.js";
import { describeSecret } from "../lib/redact.js";
import { DEFAULT_CONTENT_BUCKET, DEFAULT_MEDIA_BUCKET } from "./buckets.js";
import { DryRunDeployHook, HttpDeployHook, type DeployHook } from "./deploy.js";
import { createR2Operations } from "./s3-operations.js";
import { S3Storage } from "./s3-storage.js";
import {
  DryRunStorage,
  MemoryStorage,
  type StorageAdapter,
} from "./storage.js";

/**
 * How a command reaches storage.
 *
 * One place decides which credentials are used, which buckets are opened, and —
 * critically — whether the adapters may mutate anything at all. When a command
 * runs without `--apply`, every adapter is wrapped in `DryRunStorage` and the
 * deploy hook is replaced by one that cannot contact anything. A command
 * therefore cannot forget to check the flag: the object it holds is physically
 * incapable of writing.
 *
 * There are three credential groups:
 *
 * | Role      | Variables                                | Used by                     |
 * | --------- | ---------------------------------------- | --------------------------- |
 * | `build`   | `R2_BUILD_*`                             | `build:pages`, read-only    |
 * | `author`  | `R2_AUTHOR_*`                            | publish, rollback, media    |
 * | `cleanup` | `R2_CLEANUP_*`                           | `content:cleanup --apply`   |
 */

export type CredentialRole = "build" | "author" | "cleanup";

export interface PortsRequest {
  readonly role: CredentialRole;
  readonly content?: boolean;
  readonly media?: boolean;
  readonly deploy?: boolean;
  readonly dryRun: boolean;
}

export interface ReleasePorts {
  readonly content: StorageAdapter;
  readonly media: StorageAdapter;
  readonly deploy: DeployHook;
  /** A description safe to print: bucket names and whether secrets are set. */
  readonly description: string;
}

export interface PortsFactory {
  create(request: PortsRequest): ReleasePorts;
}

const CREDENTIAL_VARIABLES: Readonly<
  Record<
    CredentialRole,
    { readonly accessKeyId: string; readonly secretAccessKey: string }
  >
> = {
  build: {
    accessKeyId: "R2_BUILD_ACCESS_KEY_ID",
    secretAccessKey: "R2_BUILD_SECRET_ACCESS_KEY",
  },
  author: {
    accessKeyId: "R2_AUTHOR_ACCESS_KEY_ID",
    secretAccessKey: "R2_AUTHOR_SECRET_ACCESS_KEY",
  },
  cleanup: {
    accessKeyId: "R2_CLEANUP_ACCESS_KEY_ID",
    secretAccessKey: "R2_CLEANUP_SECRET_ACCESS_KEY",
  },
};

function rolePurpose(request: PortsRequest): string {
  switch (request.role) {
    case "build":
      return "read content and media during a Pages build";
    case "author":
      return "publish, roll back or upload media";
    case "cleanup":
      return "delete unreferenced objects";
  }
}

/**
 * R2-backed ports.
 *
 * Everything is created lazily per request, so a command that only lists
 * releases never constructs a media client, and a missing credential for a
 * bucket the command does not touch cannot make it fail.
 */
export function createR2PortsFactory(
  env: Environment = currentEnvironment(),
): PortsFactory {
  return {
    create(request: PortsRequest): ReleasePorts {
      const needsRemote =
        request.content === true ||
        request.media === true ||
        request.deploy === true;
      if (!needsRemote) {
        throw new UsageError(
          "This command asked for no storage at all; that is a bug in the command.",
        );
      }

      const variables = CREDENTIAL_VARIABLES[request.role];
      const accountId = env.require(
        "R2_ACCOUNT_ID",
        `reach R2 to ${rolePurpose(request)}`,
      );
      const contentBucket = env.withDefault(
        "R2_CONTENT_BUCKET",
        DEFAULT_CONTENT_BUCKET,
      );
      const mediaBucket = env.withDefault(
        "R2_MEDIA_BUCKET",
        DEFAULT_MEDIA_BUCKET,
      );

      const credentials = (): {
        accountId: string;
        accessKeyId: string;
        secretAccessKey: string;
      } => {
        const accessKeyId = env.require(
          variables.accessKeyId,
          `reach R2 to ${rolePurpose(request)}`,
        );
        const secretAccessKey = env.require(
          variables.secretAccessKey,
          `reach R2 to ${rolePurpose(request)}`,
        );
        return { accountId, accessKeyId, secretAccessKey };
      };

      const wrap = (adapter: StorageAdapter): StorageAdapter =>
        request.dryRun ? new DryRunStorage(adapter) : adapter;

      const content = wrap(
        request.content === true
          ? new S3Storage({
              bucket: contentBucket,
              operations: createR2Operations({
                ...credentials(),
                label: "r2-content",
              }),
              label: `content bucket ${contentBucket}`,
            })
          : new MemoryStorage(`content bucket (unused)`),
      );

      const media = wrap(
        request.media === true
          ? new S3Storage({
              bucket: mediaBucket,
              operations: createR2Operations({
                ...credentials(),
                label: "r2-media",
              }),
              label: `media bucket ${mediaBucket}`,
            })
          : new MemoryStorage("media bucket (unused)"),
      );

      let deploy: DeployHook = new DryRunDeployHook();
      let deployDescription = "deploy hook (not requested)";

      if (request.deploy === true) {
        // The URL is a password, so only its presence is ever described.
        const hasUrl = env.has("CF_PAGES_DEPLOY_HOOK_URL");
        deployDescription = `deploy hook ${describeSecret(env.get("CF_PAGES_DEPLOY_HOOK_URL"))}`;
        if (request.dryRun) {
          deploy = new DryRunDeployHook();
        } else {
          if (!hasUrl) {
            throw new CredentialsError(
              "CF_PAGES_DEPLOY_HOOK_URL is required to trigger a Pages build; it is currently unset. Set it in .env (see .env.example).",
            );
          }
          /*
           * Checked here, when the hook is built, rather than left to the fetch
           * that happens last: the publish path uploads objects and moves the
           * active pointer before it triggers the build, so a destination that
           * can never be reached should be refused before any of that has
           * happened. The hook is an operator secret, but it is still a URL that
           * goes out over the network, so it passes the same check as any other.
           */
          const hookUrl = assertFetchableOrigin(
            env.require("CF_PAGES_DEPLOY_HOOK_URL", "trigger a Pages build"),
          );
          deploy = new HttpDeployHook({
            url: hookUrl.toString(),
            fetch: (input, init) => globalThis.fetch(input, init),
          });
        }
      }

      const parts: string[] = [];
      if (request.content === true)
        parts.push(
          `content bucket ${contentBucket} (${request.role} credentials)`,
        );
      if (request.media === true)
        parts.push(`media bucket ${mediaBucket} (${request.role} credentials)`);
      parts.push(deployDescription);
      if (request.dryRun) parts.push("dry run: no writes are possible");

      return { content, media, deploy, description: parts.join(", ") };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Test wiring                                                                 */
/* -------------------------------------------------------------------------- */

export interface MemoryPortsOptions {
  readonly content?: MemoryStorage;
  readonly media?: MemoryStorage;
  readonly deploy?: DeployHook;
  readonly dryRun?: boolean;
}

export interface MemoryPorts extends ReleasePorts {
  readonly contentStore: MemoryStorage;
  readonly mediaStore: MemoryStorage;
}

/**
 * In-process ports for tests and for planning: no credentials, no network, and
 * the same dry-run wrapping the real factory applies.
 */
export function createMemoryPorts(
  options: MemoryPortsOptions = {},
): MemoryPorts {
  const contentStore = options.content ?? new MemoryStorage("memory-content");
  const mediaStore = options.media ?? new MemoryStorage("memory-media");
  const dryRun = options.dryRun ?? true;

  return {
    contentStore,
    mediaStore,
    content: dryRun ? new DryRunStorage(contentStore) : contentStore,
    media: dryRun ? new DryRunStorage(mediaStore) : mediaStore,
    deploy: options.deploy ?? new DryRunDeployHook(),
    description: `in-memory content and media buckets${dryRun ? ", dry run" : ""}`,
  };
}

/** A factory that always returns the same ports. The seam tests inject. */
export function createFixedPortsFactory(ports: ReleasePorts): PortsFactory {
  return {
    create(): ReleasePorts {
      return ports;
    },
  };
}
