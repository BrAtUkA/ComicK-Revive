/**
 * Bot-wall (Cloudflare et al.) challenge detection shared by the unlock flow
 * and the source engines. Cloudflare sometimes serves the challenge
 * interstitial with HTTP 200, so status codes alone can't tell "blocked"
 * from "empty results" — the body has to be sniffed.
 */

// Match ONLY the challenge interstitial, never the benign bot-management
// script (`/cdn-cgi/challenge-platform/scripts/...`) that Cloudflare embeds
// on cleared pages too — matching that substring made every probe of a
// solved site look "still challenged" and loop forever.
const CHALLENGE_RE = /just a moment|_cf_chl_opt|cf-browser-verification|id="challenge-(?:running|stage|error)"/i;

/** True when an HTML body is a bot-wall challenge page. Only the head of the document matters. */
export function looksChallenged(body: string): boolean {
  return CHALLENGE_RE.test(body.slice(0, 6000));
}
