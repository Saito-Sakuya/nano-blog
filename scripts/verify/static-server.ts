import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";

import {
  headersForPath,
  loadHeadersFile,
  type HeaderRule,
} from "./headers-file.js";

/**
 * The static server the browser-facing verification scripts share.
 *
 * `pnpm test:e2e`, `pnpm test:a11y` and `pnpm test:visual` all need the same
 * thing: a built directory served the way Cloudflare Pages serves it. This
 * module is that server, in one place, so the three cannot drift into
 * disagreeing about what the deployed site does.
 *
 * The project's own preview server is not usable from here. Astro 7
 * detects that it is running under an agent and moves `astro preview` into the
 * background, where it takes a single global lock and refuses `--ignore-lock`:
 * a second preview cannot be started, and a child process cannot own the first
 * one. Serving the files directly is both the workaround and the more faithful
 * model — `index.html` for a directory URL, a 301 to the canonical trailing
 * slash form for a file-like path that resolves to one, and the 404 document
 * with a 404 status for everything else, which is what Pages does for this
 * build.
 *
 * It also applies `_headers` to file responses, because the platform applies it
 * and nothing local did. A CSP that forbade WebAssembly once shipped and broke
 * search on every deployment while every local check passed; a server that reads
 * the same file makes that class of mistake visible where it is cheap to fix.
 * One directive is removed on the way through — `upgrade-insecure-requests`,
 * which cannot be satisfied by an HTTP-only server and would turn every
 * subresource request into an unreachable `https://localhost` one. See
 * `forPlainHttp` for why dropping that single directive is the right trade.
 * Function responses deliberately do not get these headers, matching Pages,
 * which does not apply `_headers` to anything a Function produced.
 */

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

function contentTypeOf(file: string): string {
  return (
    CONTENT_TYPES[path.posix.extname(file).toLowerCase()] ??
    "application/octet-stream"
  );
}

/** Resolve a URL path inside the build root, or `null` if it escapes it. */
function safeJoin(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const normalized = path.posix.normalize(decoded);
  if (normalized.includes("..")) return null;
  return path.join(root, normalized);
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/**
 * Rewrite the policy for a server that speaks plain HTTP.
 *
 * Two adjustments, both narrow for the same reason: the rest of the policy is
 * the point of applying this file locally.
 *
 * `upgrade-insecure-requests` is removed. It tells the browser to rewrite
 * `http://` subresource requests to `https://`. On the deployment that is
 * exactly right; here it is exactly wrong, because this server speaks HTTP only
 * and every stylesheet and script the page asks for would become an
 * `https://localhost:<port>/…` request that cannot connect — WebKit reports
 * `SSL connect error` and the page loses its styles and scripts.
 *
 * `img-src` and `media-src` are extended with the media origins the build under
 * test actually points at, when they are not the production origin. A build made
 * with `PUBLIC_MEDIA_ORIGIN=http://127.0.0.1:<port>` is a documented local
 * configuration — `scripts/verify/lighthouse.ts` uses it so the image and LCP
 * audits measure real covers instead of fallback panels — while the shipped
 * policy names only `https://media.example.invalid`. Without this every one of those
 * images is blocked and that measurement quietly goes back to measuring empty
 * boxes. Only these two directives are touched: `script-src`, `connect-src`,
 * `frame-src` and `form-action` stay exactly as shipped, because a `script-src`
 * missing `'wasm-unsafe-eval'` is the class of mistake this server exists to
 * make visible.
 */
export function forPlainHttp(
  headers: Readonly<Record<string, string>>,
  mediaOrigins: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "content-security-policy") {
      out[name] = value;
      continue;
    }

    out[name] = value
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && part !== "upgrade-insecure-requests")
      .map((directive) => {
        const [directiveName] = directive.split(/\s+/u);
        if (
          mediaOrigins.length === 0 ||
          (directiveName !== "img-src" && directiveName !== "media-src")
        ) {
          return directive;
        }
        const missing = mediaOrigins.filter(
          (origin) => !directive.includes(origin),
        );
        return [...directive.split(/\s+/u), ...missing].join(" ");
      })
      .join("; ");
  }
  return out;
}

async function serveFile(
  response: ServerResponse,
  file: string,
  status: number,
  method: string,
  extraHeaders: Readonly<Record<string, string>> = {},
  mediaOrigins: readonly string[] = [],
): Promise<void> {
  response.writeHead(status, {
    "content-type": contentTypeOf(file),
    ...forPlainHttp(extraHeaders, mediaOrigins),
  });
  if (method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
}

export interface StaticServerOptions {
  /**
   * Handles a request before the filesystem is consulted.
   *
   * Used to mount the comment and view API in front of a build, so the browser
   * tests drive the real handlers over real HTTP. Returning `null` falls through
   * to serving files, which is what every non-API path does.
   */
  readonly handleRequest?: (
    request: Request,
    address: string,
  ) => Promise<Response | null>;

  /**
   * Extra origins to permit in `img-src` and `media-src`.
   *
   * For a build whose media origin is not the production one — see
   * `forPlainHttp`. Omitted by every caller that serves a normally-built
   * directory, so the shipped policy is what those runs see.
   */
  readonly allowedMediaOrigins?: readonly string[];
}

/** Serve one built directory over HTTP on `port`. */
export async function startStaticServer(
  root: string,
  port: number,
  options: StaticServerOptions = {},
): Promise<Server> {
  const headerRules: readonly HeaderRule[] = await loadHeadersFile(root);
  const mediaOrigins = options.allowedMediaOrigins ?? [];

  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", `http://localhost:${port}`);
      const pathname = url.pathname;

      /*
       * The API is tried first, and only for its own paths: the handler returns
       * `null` for anything else so `/posts/...` never reaches it.
       */
      if (options.handleRequest !== undefined) {
        const address = request.socket.remoteAddress ?? "unknown";
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === "string") headers.set(name, value);
          else if (Array.isArray(value)) headers.set(name, value.join(", "));
        }
        const body =
          method === "GET" || method === "HEAD"
            ? undefined
            : await new Promise<Buffer>((resolve) => {
                const chunks: Buffer[] = [];
                request.on("data", (chunk: Buffer) => chunks.push(chunk));
                request.on("end", () => {
                  resolve(Buffer.concat(chunks));
                });
              });

        /*
         * `Uint8Array` rather than `Buffer`: `exactOptionalPropertyTypes` is on
         * and Node's `Buffer` is not assignable to `BodyInit`, while a plain
         * view over the same bytes is.
         */
        const apiResponse = await options.handleRequest(
          new Request(url, {
            method,
            headers,
            ...(body === undefined ? {} : { body: new Uint8Array(body) }),
          }),
          address,
        );

        if (apiResponse !== null) {
          const outHeaders: Record<string, string> = {};
          apiResponse.headers.forEach((value, name) => {
            outHeaders[name] = value;
          });
          response.writeHead(apiResponse.status, outHeaders);
          response.end(Buffer.from(await apiResponse.arrayBuffer()));
          return;
        }
      }

      const direct = safeJoin(root, pathname);
      if (direct === null) {
        response.writeHead(400, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("bad request");
        return;
      }

      /*
       * `_headers` is matched against the request path, exactly as the platform
       * matches it — not against the file that ends up being served. That
       * distinction is the whole reason `/posts/x/` needs its own rule: the
       * request path has no `.html` in it.
       */
      const fileHeaders = headersForPath(headerRules, pathname);

      // A directory URL is served by its `index.html`.
      if (pathname.endsWith("/")) {
        const index = path.join(direct, "index.html");
        if (await isFile(index)) {
          await serveFile(
            response,
            index,
            200,
            method,
            fileHeaders,
            mediaOrigins,
          );
          return;
        }
      } else if (await isFile(direct)) {
        await serveFile(
          response,
          direct,
          200,
          method,
          fileHeaders,
          mediaOrigins,
        );
        return;
      } else {
        // `/about` where `about/index.html` exists: Pages redirects to the
        // canonical trailing-slash form rather than serving the page twice.
        const index = path.join(direct, "index.html");
        if (await isFile(index)) {
          response.writeHead(301, { location: `${pathname}/${url.search}` });
          response.end();
          return;
        }
      }

      // Everything else is the 404 document, with the status Cloudflare Pages
      // would return. A missing 404.html is a broken build, not a 200.
      const notFound = path.join(root, "404.html");
      if (await isFile(notFound)) {
        await serveFile(
          response,
          notFound,
          404,
          method,
          fileHeaders,
          mediaOrigins,
        );
        return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return server;
}

export function stopStaticServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Poll `url` until it answers something other than a server error. */
export async function waitForServer(
  url: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${url} did not answer within ${timeoutMs} ms.`);
}

/** Fail early with a useful message when a build directory is missing. */
export function assertBuildExists(root: string, label: string): void {
  if (!existsSync(path.join(root, "index.html"))) {
    throw new Error(
      `${label} has no index.html. Build it first: ${label === "dist" ? "pnpm build" : "pnpm build:fixtures"}.`,
    );
  }
}
