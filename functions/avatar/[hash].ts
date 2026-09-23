import { identiconSvg } from "../../src/lib/comments/identicon.js";
import { OutboundBudget } from "../lib/outbound-budget.js";
import type { PagesContext } from "../lib/context.js";

/**
 * `/avatar/<hash>`
 *
 * A same-origin proxy for a commenter's avatar.
 *
 * ## Why a proxy rather than a link to Gravatar
 *
 * The obvious implementation is `<img src="https://gravatar.com/avatar/<hash>">`
 * and it is wrong here for two reasons:
 *
 * 1. **It would send every reader's address to a third party.** Loading an
 *    image is a request, and a request carries the reader's IP, their user agent
 *    and the page they are on. The site's whole privacy position is that no
 *    third party learns who is reading; a comment avatar would quietly undo that
 *    for every page with a comment.
 * 2. **It would weaken the Content-Security-Policy.** `img-src` would have to
 *    name Gravatar's domain, and the CSP is written so that adding an external
 *    source is a deliberate, visible act. Proxying keeps `img-src 'self'`, and
 *    the policy that ships is the policy that was reviewed.
 *
 * The proxy fetches with `d=404` and `f=y`, which asks Gravatar to answer 404
 * rather than a default image when the address has no avatar. That is the only
 * way to tell the two cases apart — with a default image every commenter without
 * an account would wear the same silhouette — and it is what lets this endpoint
 * fall back to a locally generated mark instead.
 *
 * ## What is not done here
 *
 * The digest is not verified against a stored comment. It is a lookup key, it is
 * one-way, and the only thing an attacker can do with a guessed digest is cause
 * this server to fetch that one address's public avatar — which is what the
 * image would have shown anyway. Verifying would mean a database read on every
 * image request for no gain.
 */

/** Gravatar's host. The only outbound request this project makes for a reader. */
const GRAVATAR = "https://gravatar.com/avatar";

/** How long a resolved avatar may be cached by anything in between. */
const CACHE_SECONDS = 60 * 60 * 24;

/**
 * How long a generated mark may be cached.
 *
 * Shorter than a resolved avatar on purpose. The mark means "this address had no
 * Gravatar when we asked", which is a fact that can change — a commenter who
 * signs up tomorrow should not wear the generated mark for a day afterwards.
 */
const FALLBACK_CACHE_SECONDS = 60 * 60;

/** Give up rather than hold a request open behind a slow upstream. */
const UPSTREAM_TIMEOUT_MS = 3000;

const HASH_PATTERN = /^[0-9a-f]{32}$/u;

/*
 * A ceiling on outbound requests from this isolate.
 *
 * The digest is the only input, so an attacker can request a fresh, valid and
 * unknown hash every time and turn this endpoint into an amplifier against
 * Gravatar and against the operator's quota. The budget bounds that work per
 * isolate; `functions/lib/outbound-budget.ts` states plainly what it does and
 * does not cover. When it is exhausted the reader still gets an avatar — the
 * locally generated one — so the only visible effect is a different picture.
 */
const gravatarBudget = new OutboundBudget({ limit: 240, windowMs: 60_000 });

function svgResponse(
  svg: string,
  status = 200,
  cacheSeconds = FALLBACK_CACHE_SECONDS,
): Response {
  return new Response(svg, {
    status,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": `public, max-age=${String(cacheSeconds)}, immutable`,
      // The mark is generated from a digest and carries no text; a script
      // context could not do anything with it, but the header costs nothing and
      // removes the question.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const raw = context.params["hash"] ?? "";
  const hash = raw.toLowerCase();

  /*
   * Reject anything that is not a digest before it reaches the network or the
   * generator. A non-hex value is either a mistake or an attempt to steer the
   * outbound request, and `identiconSvg` refuses it too — belt and braces,
   * because this is the one place a caller-supplied string approaches an
   * outbound URL.
   */
  if (!HASH_PATTERN.test(hash)) {
    return new Response("Not found", { status: 404 });
  }

  const upstream = `${GRAVATAR}/${hash}?d=404&f=y&s=160`;

  /*
   * Past the budget, answer from the local generator without asking upstream.
   * Checked before the request rather than after, because the point is to not
   * make the request at all.
   */
  if (!gravatarBudget.take()) {
    return svgResponse(identiconSvg({ hash, size: 160 }));
  }

  try {
    const response = await fetch(upstream, {
      // No credentials and no referrer: this request is between the edge and
      // Gravatar, and the reader is not a party to it.
      headers: { accept: "image/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.startsWith("image/")) {
        const bytes = await response.arrayBuffer();
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": contentType,
            "cache-control": `public, max-age=${String(CACHE_SECONDS)}, immutable`,
            // The bytes come from a third party, so this response gets the same
            // policy the generated mark carries rather than relying on the
            // middleware to add one. A body served from someone else's origin is
            // not the place to leave that to a layer whose ordering is a
            // platform detail.
            "content-security-policy": "default-src 'none'",
            "x-content-type-options": "nosniff",
          },
        });
      }
    }

    /*
     * 404 means "no avatar for this address", which is the common case and not
     * an error. Anything else — a timeout, a 5xx, a network failure — lands here
     * too, and the same answer is right for it: show a generated mark rather
     * than a broken image, and never let a third party's availability decide
     * whether this page renders.
     */
    return svgResponse(identiconSvg({ hash, size: 160 }));
  } catch {
    return svgResponse(identiconSvg({ hash, size: 160 }));
  }
}
