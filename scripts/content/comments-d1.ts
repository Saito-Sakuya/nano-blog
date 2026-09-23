import type { CommentStatus } from "../../src/lib/comments/rules.js";
import type { FetchLike } from "../lib/deps.js";
import { CredentialsError, RemoteError } from "../lib/errors.js";
import type { Environment } from "../lib/env.js";

/**
 * Reading and updating comments through the Cloudflare D1 REST API.
 *
 * ## Why the REST API rather than `wrangler`
 *
 * Both work. The project's rule for talking to Cloudflare is that a local
 * command may do so when it is explicit, credential-scoped and never invoked by
 * a build, and `wrangler d1 execute` satisfies that — it is documented in
 * docs/CLOUDFLARE_SETUP.md as the zero-code path for anyone who prefers it.
 *
 * This module exists because `wrangler` is a large dependency that would be
 * installed for one command, and because the REST API lets the flow be a dry run
 * by default in the same way every other command in `scripts/` is. The
 * statements sent here are the same ones wrangler would send.
 *
 * ## Credentials
 *
 * A token scoped to D1 edit on one database. It is registered in
 * `scripts/lib/redact.ts`, so it cannot be printed even if it is interpolated
 * into a message by mistake, and it is only read by this command.
 */

export interface CommentRecord {
  readonly id: string;
  readonly postId: string;
  readonly authorName: string;
  readonly emailHash: string;
  readonly bodyMarkdown: string;
  readonly bodyHtml: string;
  readonly status: CommentStatus;
  readonly createdAt: string;
}

export interface ReviewClient {
  list(status: CommentStatus | "any", limit: number): Promise<CommentRecord[]>;
  setStatus(id: string, status: CommentStatus): Promise<boolean>;
  countByStatus(status: CommentStatus): Promise<number>;
}

/** How the environment supplies the three values this needs. */
export interface ReviewCredentials {
  readonly accountId: string;
  readonly databaseId: string;
  readonly token: string;
}

/**
 * Read the credentials, or explain precisely which one is missing.
 *
 * `R2_ACCOUNT_ID` is reused for the account rather than introducing a second
 * variable holding the same value: there is one Cloudflare account here.
 */
export function readReviewCredentials(env: Environment): ReviewCredentials {
  const accountId = env.get("R2_ACCOUNT_ID");
  const databaseId = env.get("CF_D1_DATABASE_ID");
  const token = env.get("CF_D1_API_TOKEN");

  const missing: string[] = [];
  if (accountId === undefined || accountId.length === 0) {
    missing.push("R2_ACCOUNT_ID");
  }
  if (databaseId === undefined || databaseId.length === 0) {
    missing.push("CF_D1_DATABASE_ID");
  }
  if (token === undefined || token.length === 0) {
    missing.push("CF_D1_API_TOKEN");
  }

  if (missing.length > 0) {
    throw new CredentialsError(
      `Reviewing comments needs ${missing.join(", ")}. Set them in .env (see .env.example); the token needs D1 edit permission on the comments database.`,
    );
  }

  return {
    accountId: accountId as string,
    databaseId: databaseId as string,
    token: token as string,
  };
}

interface D1Response {
  readonly success?: boolean;
  readonly errors?: readonly { readonly message?: string }[];
  readonly result?: readonly {
    readonly results?: readonly Record<string, unknown>[];
    readonly meta?: { readonly changes?: number };
  }[];
}

/**
 * Run one statement through the D1 query API.
 *
 * The endpoint takes a list of statements and returns one result per statement;
 * this module only ever sends one, because a multi-statement call would make the
 * failure reporting ambiguous and none of these operations needs a transaction
 * — approving one comment is independent of approving the next.
 */
async function query(
  credentials: ReviewCredentials,
  fetchImpl: FetchLike,
  sql: string,
  params: readonly unknown[],
): Promise<D1Response["result"]> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database/${credentials.databaseId}/query`;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    });
  } catch (error) {
    // The message may contain the endpoint but not the token: the header is not
    // part of a fetch error, and the token is redacted anyway.
    throw new RemoteError(
      `Could not reach the Cloudflare API: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const text = await response.text();
  let payload: D1Response;
  try {
    payload = JSON.parse(text) as D1Response;
  } catch {
    throw new RemoteError(
      `The Cloudflare API returned ${String(response.status)} with a body that is not JSON.`,
    );
  }

  if (!response.ok || payload.success !== true) {
    const detail =
      payload.errors
        ?.map((entry) => entry.message ?? "unknown error")
        .join("; ") ?? `HTTP ${String(response.status)}`;
    throw new RemoteError(`The D1 query failed: ${detail}`);
  }

  return payload.result;
}

/** A client backed by the real API. */
export function createReviewClient(
  credentials: ReviewCredentials,
  fetchImpl: FetchLike,
): ReviewClient {
  const rows = async (
    sql: string,
    params: readonly unknown[],
  ): Promise<CommentRecord[]> => {
    const result = await query(credentials, fetchImpl, sql, params);
    const results = result?.[0]?.results ?? [];
    return results.map((row) => ({
      id: String(row["id"] ?? ""),
      postId: String(row["post_id"] ?? ""),
      authorName: String(row["author_name"] ?? ""),
      emailHash: String(row["email_hash"] ?? ""),
      bodyMarkdown: String(row["body_markdown"] ?? ""),
      bodyHtml: String(row["body_html"] ?? ""),
      status: String(row["status"] ?? "pending") as CommentStatus,
      createdAt: String(row["created_at"] ?? ""),
    }));
  };

  return {
    list(status, limit) {
      return status === "any"
        ? rows(`SELECT * FROM comments ORDER BY created_at DESC LIMIT ?`, [
            limit,
          ])
        : rows(
            `SELECT * FROM comments WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
            [status, limit],
          );
    },

    async setStatus(id, status) {
      const result = await query(
        credentials,
        fetchImpl,
        `UPDATE comments SET status = ? WHERE id = ?`,
        [status, id],
      );
      return (result?.[0]?.meta?.changes ?? 0) > 0;
    },

    async countByStatus(status) {
      const result = await query(
        credentials,
        fetchImpl,
        `SELECT COUNT(*) AS total FROM comments WHERE status = ?`,
        [status],
      );
      const total = result?.[0]?.results?.[0]?.["total"];
      return typeof total === "number" ? total : 0;
    },
  };
}
