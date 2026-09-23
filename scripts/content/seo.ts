import path from "node:path";

import "../lib/env.js";
import {
  ANI_CONTENT_DIR,
  SEO_SUGGESTIONS_DIR,
} from "../../src/lib/content/paths.js";
import { SITE_URL } from "../../src/lib/site.js";
import type { FlagSpec } from "../lib/args.js";
import type { CommandDependencies } from "../lib/deps.js";
import {
  EXIT,
  CredentialsError,
  ValidationError,
  type ExitCode,
} from "../lib/errors.js";
import { ensureDirectory, writeFileAtomic } from "../lib/fs-util.js";
import {
  isDirectRun,
  runCli,
  type CliContext,
  type CliDefinition,
} from "../lib/run.js";
import { loadContentSource, resolveLocalSource } from "./load.js";
import {
  buildSeoFields,
  buildSeoPrompt,
  buildSuggestionFiles,
  parseSeoResponse,
  previewFields,
  seoEndpoint,
  SEO_MODEL_ID,
  type SeoFields,
} from "./seo-plan.js";

/**
 * `content:seo` — ask Workers AI for suggestions about one article.
 *
 * The default run shows what would be sent, to whom, and how many characters
 * each field is, and stops there: no request, no credentials, no files. Only
 * `--send` performs the call, and that is the only network access this command
 * has — the build, the preview and CI never reach Workers AI at all.
 *
 * The answer is written to `.ani-content/seo-suggestions/` as a timestamped
 * JSON file and a unified diff. The article is not touched. Reviewing a
 * suggestion and applying it are two separate, deliberate acts.
 */

const FLAGS: readonly FlagSpec[] = [
  {
    name: "send",
    kind: "boolean",
    summary:
      "Actually send the excerpt to Workers AI. Without it nothing leaves the machine.",
  },
];

export const seoDefinition: CliDefinition = {
  command: "content:seo",
  summary:
    "Show, and optionally send, the metadata an article would use for SEO suggestions.",
  usage: [
    "content:seo <content-path> [--json]",
    "content:seo <content-path> --send",
  ],
  flags: FLAGS,
  notes: [
    "Without --send: zero network requests.",
    `The model is fixed at ${SEO_MODEL_ID}; this command never falls back to another one.`,
    "Suggestions are written to .ani-content/seo-suggestions/; the Markdown is never rewritten.",
  ],
  handler: handleSeo,
};

async function handleSeo(context: CliContext): Promise<ExitCode> {
  const { reporter, flags, positionals } = context;

  const target = positionals[0];
  if (target === undefined) {
    throw new ValidationError(
      "content:seo needs a content path, e.g. `pnpm content:seo posts/dev/web/a.md`.",
    );
  }
  if (positionals.length > 1) {
    throw new ValidationError("content:seo takes exactly one content path.");
  }

  const resolved = await resolveLocalSource();
  const source = await loadContentSource({
    root: resolved.root,
    kind: resolved.kind,
  });

  const normalizedTarget = target.replace(/\\/gu, "/").replace(/^\.\//u, "");
  const entry =
    source.entries.find(
      (candidate) => candidate.relativePath === normalizedTarget,
    ) ??
    source.entries.find(
      (candidate) =>
        path.basename(candidate.relativePath) ===
        path.basename(normalizedTarget),
    );

  if (entry === undefined) {
    throw new ValidationError(
      `${target} is not a content file in the ${resolved.label}. Known files: ${source.entries.map((candidate) => candidate.relativePath).join(", ") || "(none)"}.`,
    );
  }

  if (entry.parsed === null) {
    throw new ValidationError(
      `${entry.relativePath} does not pass its frontmatter schema, so suggestions about its metadata would be meaningless.`,
      {
        issues: entry.issues.map(
          (issue) => `${issue.field ?? "(root)"}: ${issue.message}`,
        ),
      },
    );
  }

  const fields: SeoFields = buildSeoFields(entry);
  const accountId = context.env.get("CF_WORKERS_AI_ACCOUNT_ID");
  const endpoint = seoEndpoint(accountId ?? "<CF_WORKERS_AI_ACCOUNT_ID>");

  reporter.heading(`Fields that would be sent for ${entry.relativePath}`);
  for (const row of previewFields(fields)) {
    reporter.action("plan", row.name, {
      detail: `${row.characters} character(s): ${row.preview}`,
    });
  }

  reporter.heading("Destination");
  reporter.note(`  model   : ${SEO_MODEL_ID}`);
  reporter.note(`  endpoint: ${endpoint}`);
  reporter.note(
    `  recipient: ${new URL(SITE_URL).host} → Cloudflare Workers AI`,
  );
  reporter.note(
    `  account : ${accountId ?? "(CF_WORKERS_AI_ACCOUNT_ID is unset)"}`,
  );

  if (!flags.boolean("send")) {
    const preview = JSON.stringify({
      fields: previewFields(fields),
      model: SEO_MODEL_ID,
      endpoint: accountId === undefined ? null : endpoint,
      sent: false,
    });
    if (context.json) {
      reporter.note("preview (nothing was sent):");
      reporter.note(preview);
    }
    reporter.setSummary(
      "Preview only: no request was made. Re-run with --send to ask Workers AI for suggestions.",
    );
    return EXIT.OK;
  }

  if (accountId === undefined) {
    throw new CredentialsError(
      "CF_WORKERS_AI_ACCOUNT_ID is required to send a request; it is currently unset.",
    );
  }
  const token = context.env.require(
    "CF_WORKERS_AI_API_TOKEN",
    "call Workers AI",
  );

  const prompt = buildSeoPrompt(fields);
  reporter.note(
    `sending ${previewFields(fields).length} field(s) to ${SEO_MODEL_ID}…`,
  );

  const response = await context.dependencies.fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: 0.2,
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    const detail = await safeText(response);
    throw new ValidationError(
      `Workers AI responded with HTTP ${response.status} for model ${SEO_MODEL_ID}${detail.length === 0 ? "" : `: ${detail}`}. If the model is unavailable, update SEO_MODEL_ID deliberately; this command never switches models on its own.`,
    );
  }

  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch (error) {
    throw new ValidationError(
      `Workers AI returned a body that is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const suggestion = parseSeoResponse(payload);
  const files = buildSuggestionFiles({
    entry,
    fields,
    suggestion,
    instant: context.dependencies.now(),
    model: SEO_MODEL_ID,
  });

  // Suggestions live inside `.ani-content` and nowhere else; the article is
  // never modified by this command.
  if (!SEO_SUGGESTIONS_DIR.startsWith(ANI_CONTENT_DIR)) {
    throw new ValidationError(
      "The suggestion directory is not inside .ani-content; refusing to write.",
    );
  }

  await ensureDirectory(SEO_SUGGESTIONS_DIR);
  await writeFileAtomic(
    path.join(SEO_SUGGESTIONS_DIR, files.jsonFileName),
    files.json,
  );
  await writeFileAtomic(
    path.join(SEO_SUGGESTIONS_DIR, files.diffFileName),
    files.diff,
  );

  reporter.action(
    "write",
    path.join(".ani-content/seo-suggestions", files.jsonFileName),
  );
  if (files.diff.length > 0) {
    reporter.action(
      "write",
      path.join(".ani-content/seo-suggestions", files.diffFileName),
    );
    reporter.heading("Suggested frontmatter changes");
    reporter.note(files.diff);
  } else {
    reporter.note("The suggestion does not change any frontmatter field.");
  }

  reporter.setSummary(
    `Wrote a suggestion for ${entry.relativePath} to .ani-content/seo-suggestions/. Nothing was applied.`,
  );
  return EXIT.OK;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}

export async function runSeo(
  argv: readonly string[],
  dependencies: CommandDependencies = {},
): Promise<ExitCode> {
  return runCli(seoDefinition, argv, dependencies);
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = await runSeo(process.argv.slice(2));
}
