import { currentEnvironment, type Environment } from "./env.js";
import type { PortsFactory } from "../release/ports.js";
import type { ImageProcessor } from "../media/processor.js";

/**
 * Injected dependencies.
 *
 * Every command takes a `Partial<CommandDependencies>` and resolves it against
 * these defaults. That is the seam a test uses: supply a fake storage factory
 * and a `content:publish` run can be asserted to perform zero puts, zero
 * deletes and zero deploy-hook calls without touching the network.
 *
 * The defaults are lazy on purpose. Creating the R2 ports factory is what needs
 * credentials, so a command that never opens a bucket — `content:validate`,
 * `media:add` in dry-run, `content:seo` in preview mode — runs with no
 * credentials at all, while a command that does need them fails with exit
 * code 4 the moment it asks.
 */

/** The shape of `fetch` this project uses; injectable so tests can count calls. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface CommandDependencies {
  readonly env?: Environment;
  /** The current instant. Tests pin it; commands never call `Date.now()` directly. */
  readonly now?: () => Date;
  readonly ports?: PortsFactory;
  readonly images?: ImageProcessor;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly fetch?: FetchLike;
}

export interface ResolvedDependencies {
  readonly env: Environment;
  readonly now: () => Date;
  readonly ports: PortsFactory;
  readonly images: ImageProcessor;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly fetch: FetchLike;
}

let cachedDefaults: Pick<ResolvedDependencies, "ports" | "images"> | undefined;

/**
 * The real ports factory and image processor, created on first use.
 *
 * They are imported dynamically so that a run which never needs R2 (or never
 * needs `sharp`) does not pay for loading them, and so that a missing optional
 * native dependency cannot break an unrelated command.
 */
async function defaultInfrastructure(): Promise<
  Pick<ResolvedDependencies, "ports" | "images">
> {
  if (cachedDefaults !== undefined) return cachedDefaults;

  const [{ createR2PortsFactory }, { createSharpImageProcessor }] =
    await Promise.all([
      import("../release/ports.js"),
      import("../media/processor.js"),
    ]);

  cachedDefaults = {
    ports: createR2PortsFactory(),
    images: createSharpImageProcessor(),
  };
  return cachedDefaults;
}

export async function resolveDependencies(
  overrides: CommandDependencies = {},
): Promise<ResolvedDependencies> {
  const env = overrides.env ?? currentEnvironment();
  const needsInfrastructure =
    overrides.ports === undefined || overrides.images === undefined;
  const infrastructure = needsInfrastructure
    ? await defaultInfrastructure()
    : { ports: overrides.ports, images: overrides.images };

  return {
    env,
    now: overrides.now ?? (() => new Date()),
    ports: overrides.ports ?? infrastructure.ports,
    images: overrides.images ?? infrastructure.images,
    stdout: overrides.stdout ?? ((text) => process.stdout.write(text)),
    stderr: overrides.stderr ?? ((text) => process.stderr.write(text)),
    sleep:
      overrides.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        })),
    random: overrides.random ?? Math.random,
    fetch: overrides.fetch ?? ((input, init) => globalThis.fetch(input, init)),
  };
}

/** Forget the memoised infrastructure. Test-only. */
export function resetDefaultDependencies(): void {
  cachedDefaults = undefined;
}
