import { z } from "astro/zod";

import { SITE_URL } from "../../src/lib/site.js";
import { ValidationError } from "../lib/errors.js";
import {
  codePointLength,
  slugifyAscii,
  truncateCodePoints,
} from "../lib/unicode.js";
import { unifiedDiff } from "../lib/diff.js";
import type { ContentEntry } from "./load.js";
import { extractDocument } from "./extract.js";

/**
 * The manual SEO suggestion flow.
 *
 * Nothing here runs during a build. It is an author command that shows exactly
 * what would be sent, sends it only when asked, and writes its answer to a file
 * beside the content. It never edits the article: a suggestion that has not
 * been read is not an improvement, and a model that rewrites prose unasked is a
 * model that publishes mistakes nobody reviewed.
 *
 * The excerpt sent to Cloudflare is stripped of code blocks, URL query strings
 * and anything that looks like a credential before it leaves the machine.
 */

/** The locked model. Changing it is a deliberate edit to this constant. */
export const SEO_MODEL_ID = "@cf/qwen/qwen3.8-27b";

export const BODY_EXCERPT_LIMIT = 6000;
export const DESCRIPTION_MIN = 40;
export const DESCRIPTION_MAX = 160;
export const KEYWORDS_MIN = 3;
export const KEYWORDS_MAX = 8;

export function seoEndpoint(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${SEO_MODEL_ID}`;
}

export interface SeoFields {
  readonly title: string;
  readonly description: string | null;
  readonly headings: readonly string[];
  readonly tags: readonly string[];
  readonly excerpt: string;
}

export interface SeoFieldPreview {
  readonly name: string;
  readonly characters: number;
  readonly preview: string;
}

/**
 * Remove the parts of a body that must never leave the machine.
 *
 * Fenced code is dropped because it is not prose and can carry any secret the
 * author pasted; query strings are dropped because a signed URL is a
 * credential; long high-entropy tokens are dropped because they usually are
 * one.
 */
export function stripBodyForExcerpt(body: string): string {
  let text = body;

  // Fenced code blocks, including the info string.
  text = text.replace(/^```[\s\S]*?^```/gmu, " ");
  text = text.replace(/^~~~[\s\S]*?^~~~/gmu, " ");
  // Inline code, which is where keys and tokens usually appear.
  text = text.replace(/`[^`\n]*`/gu, " ");
  // Image and link destinations.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/gu, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1");
  // Query strings on any URL.
  text = text.replace(/(https?:\/\/[^\s)]+)\?[^\s)]*/gu, "$1");
  // Credential-shaped tokens: long hex/base64 runs, and prefixed keys.
  text = text.replace(
    /\b(?:AKIA|ASIA|sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gu,
    " ",
  );
  text = text.replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/gu, " ");
  text = text.replace(/\b[0-9a-f]{32,}\b/gu, " ");
  // HTML comments and MDX component bodies are not prose.
  text = text.replace(/<!--[\s\S]*?-->/gu, " ");

  return text
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function buildSeoFields(entry: ContentEntry): SeoFields {
  const document = extractDocument(entry.body, {
    file: entry.relativePath,
    mdx: entry.relativePath.endsWith(".mdx"),
  });

  const headings = document.headings
    .filter((heading) => heading.depth <= 3)
    .map((heading) => heading.text)
    .filter((text) => text.length > 0);

  const rawTags = entry.data["tags"];
  const tags = Array.isArray(rawTags)
    ? rawTags
        .map((tag) =>
          typeof tag === "object" &&
          tag !== null &&
          typeof (tag as { label?: unknown }).label === "string"
            ? (tag as { label: string }).label
            : null,
        )
        .filter((label): label is string => label !== null)
    : [];

  const title =
    typeof entry.data["title"] === "string" ? entry.data["title"] : "";
  const description =
    typeof entry.data["description"] === "string"
      ? entry.data["description"]
      : null;

  return {
    title,
    description,
    headings,
    tags,
    excerpt: truncateCodePoints(
      stripBodyForExcerpt(entry.body),
      BODY_EXCERPT_LIMIT,
    ),
  };
}

export function previewFields(fields: SeoFields): SeoFieldPreview[] {
  const rows: SeoFieldPreview[] = [
    {
      name: "title",
      characters: codePointLength(fields.title),
      preview: fields.title,
    },
    {
      name: "description",
      characters:
        fields.description === null ? 0 : codePointLength(fields.description),
      preview: fields.description ?? "(none)",
    },
    {
      name: "headings (H1–H3)",
      characters: fields.headings.reduce(
        (total, heading) => total + codePointLength(heading),
        0,
      ),
      preview: fields.headings.join(" | ") || "(none)",
    },
    {
      name: "tags",
      characters: fields.tags.reduce(
        (total, tag) => total + codePointLength(tag),
        0,
      ),
      preview: fields.tags.join(", ") || "(none)",
    },
    {
      name: "body excerpt",
      characters: codePointLength(fields.excerpt),
      preview: `${truncateCodePoints(fields.excerpt, 160)}${codePointLength(fields.excerpt) > 160 ? "…" : ""}`,
    },
  ];

  return rows;
}

export interface SeoPrompt {
  readonly system: string;
  readonly user: string;
}

export function buildSeoPrompt(fields: SeoFields): SeoPrompt {
  const system = [
    "You are helping an author improve the metadata of one article on a personal blog.",
    "Reply with one JSON object and nothing else, in this exact shape:",
    '{"description": string, "ogTitle": string|null, "ogDescription": string|null, "keywords": string[], "readability": string[]}',
    `description: ${DESCRIPTION_MIN}–${DESCRIPTION_MAX} characters, in the article's own language, describing what the article says.`,
    "ogTitle: optional, 1–70 characters, or null.",
    `ogDescription: optional, ${DESCRIPTION_MIN}–${DESCRIPTION_MAX} characters, or null.`,
    `keywords: ${KEYWORDS_MIN}–${KEYWORDS_MAX} short topical keywords taken from the article.`,
    "readability: 0–5 short notes about heading structure, sentence length or clarity problems, in Chinese.",
    "Do not rewrite the article. Do not invent facts, names, places or credentials.",
  ].join("\n");

  const user = [
    `Site: ${SITE_URL}`,
    `Title: ${fields.title}`,
    `Current description: ${fields.description ?? "(none)"}`,
    `Headings: ${fields.headings.join(" | ") || "(none)"}`,
    `Tags: ${fields.tags.join(", ") || "(none)"}`,
    "",
    "Article excerpt (code blocks, links and URL parameters removed):",
    fields.excerpt,
  ].join("\n");

  return { system, user };
}

/** The shape the model must answer in. Validated locally, always. */
export const seoSuggestionSchema = z.strictObject({
  description: z.string().refine((value) => {
    const length = codePointLength(value.normalize("NFC"));
    return length >= DESCRIPTION_MIN && length <= DESCRIPTION_MAX;
  }, `description must be ${DESCRIPTION_MIN}–${DESCRIPTION_MAX} characters.`),
  ogTitle: z
    .string()
    .refine(
      (value) => codePointLength(value) <= 70,
      "ogTitle must be at most 70 characters.",
    )
    .nullable(),
  ogDescription: z
    .string()
    .refine((value) => {
      const length = codePointLength(value);
      return length >= DESCRIPTION_MIN && length <= DESCRIPTION_MAX;
    }, `ogDescription must be ${DESCRIPTION_MIN}–${DESCRIPTION_MAX} characters.`)
    .nullable(),
  keywords: z
    .array(z.string().min(1))
    .min(KEYWORDS_MIN, `keywords must hold at least ${KEYWORDS_MIN} entries.`)
    .max(KEYWORDS_MAX, `keywords must hold at most ${KEYWORDS_MAX} entries.`),
  readability: z
    .array(z.string())
    .max(5, "readability must hold at most 5 notes."),
});

export type SeoSuggestion = z.output<typeof seoSuggestionSchema>;

const workersAiEnvelope = z.object({
  success: z.boolean().optional(),
  result: z.unknown().optional(),
  errors: z
    .array(
      z.object({
        code: z.union([z.number(), z.string()]).optional(),
        message: z.string().optional(),
      }),
    )
    .optional(),
  messages: z.array(z.unknown()).optional(),
});

/** Pull the first balanced JSON object out of a model's reply. */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();

  const start = candidate.indexOf("{");
  if (start === -1) {
    throw new ValidationError("The model did not return a JSON object.");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < candidate.length; index += 1) {
    const character = candidate[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        const slice = candidate.slice(start, index + 1);
        try {
          return JSON.parse(slice) as unknown;
        } catch (error) {
          throw new ValidationError(
            `The model's JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  throw new ValidationError("The model returned an unterminated JSON object.");
}

/**
 * Validate a Workers AI response.
 *
 * A `success: false` answer, or an error that names the model, is reported as
 * the model being unavailable — never as a reason to try a different one.
 */
export function parseSeoResponse(payload: unknown): SeoSuggestion {
  const envelope = workersAiEnvelope.safeParse(payload);
  if (!envelope.success) {
    throw new ValidationError(
      "Workers AI returned a response this command does not recognise.",
      {
        issues: envelope.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      },
    );
  }

  const errors = envelope.data.errors ?? [];
  if (errors.length > 0) {
    const messages = errors.map(
      (error) => error.message ?? `code ${String(error.code ?? "unknown")}`,
    );
    throw new ValidationError(
      `Workers AI reported an error for model ${SEO_MODEL_ID}: ${messages.join("; ")}. If the model is unavailable, update SEO_MODEL_ID deliberately — this command never switches models on its own.`,
    );
  }

  if (envelope.data.success === false) {
    throw new ValidationError(
      `Workers AI reported failure for model ${SEO_MODEL_ID}. If the model is unavailable, update SEO_MODEL_ID deliberately.`,
    );
  }

  const result = envelope.data.result;
  const rawText =
    typeof result === "object" &&
    result !== null &&
    typeof (result as { response?: unknown }).response === "string"
      ? (result as { response: string }).response
      : typeof result === "string"
        ? result
        : null;

  const parsed = rawText === null ? result : extractJsonObject(rawText);
  const suggestion = seoSuggestionSchema.safeParse(parsed);

  if (!suggestion.success) {
    throw new ValidationError(
      "The model answered with a shape this command will not write to disk.",
      {
        issues: suggestion.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      },
    );
  }

  return suggestion.data;
}

export interface SuggestionFiles {
  readonly jsonFileName: string;
  readonly json: string;
  readonly diffFileName: string;
  readonly diff: string;
}

/**
 * The two files a suggestion produces: the raw answer, and a diff of what
 * adopting it would change in the frontmatter. Neither is applied.
 */
export function buildSuggestionFiles(options: {
  readonly entry: ContentEntry;
  readonly fields: SeoFields;
  readonly suggestion: SeoSuggestion;
  readonly instant: Date;
  readonly model: string;
}): SuggestionFiles {
  const { entry, fields, suggestion, instant } = options;
  const stamp = instant
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d+Z$/u, "Z");
  const base = `${stamp}-${slugifyAscii(entry.collectionPath.replace(/\//gu, "-"))}`;

  const json = `${JSON.stringify(
    {
      generatedAt: instant.toISOString(),
      model: options.model,
      file: entry.relativePath,
      sent: {
        title: fields.title,
        description: fields.description,
        headings: fields.headings,
        tags: fields.tags,
        excerptCharacters: codePointLength(fields.excerpt),
      },
      suggestion,
      applied: false,
      note: "This file is a suggestion. Nothing in the content tree was changed.",
    },
    null,
    2,
  )}\n`;

  const before = [
    `description: ${fields.description ?? "(none)"}`,
    `ogTitle: ${typeof entry.data["ogTitle"] === "string" ? entry.data["ogTitle"] : "(none)"}`,
    `ogDescription: ${typeof entry.data["ogDescription"] === "string" ? entry.data["ogDescription"] : "(none)"}`,
  ].join("\n");

  const after = [
    `description: ${suggestion.description}`,
    `ogTitle: ${suggestion.ogTitle ?? "(none)"}`,
    `ogDescription: ${suggestion.ogDescription ?? "(none)"}`,
    `keywords: ${suggestion.keywords.join(", ")}`,
    ...suggestion.readability.map((note) => `# ${note}`),
  ].join("\n");

  const diff = unifiedDiff(before, after, {
    fromLabel: `${entry.relativePath} (current frontmatter)`,
    toLabel: `${entry.relativePath} (suggested)`,
    context: 2,
  });

  return {
    jsonFileName: `${base}.json`,
    json,
    diffFileName: `${base}.diff`,
    diff,
  };
}
