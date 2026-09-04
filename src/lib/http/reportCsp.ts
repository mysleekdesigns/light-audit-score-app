/**
 * The Content-Security-Policy for the standalone Lighthouse HTML report.
 *
 * `GET /api/reports/:runId?format=html` hands a browser a full HTML document ON
 * THE APP'S OWN ORIGIN, built from an audited page's data — titles, URLs, DOM
 * snippets that whoever controls the site wrote. Lighthouse escapes what it
 * renders, but if any of it ever slipped through, script running there would be
 * same-origin with the app: it could call the local API with the session cookie
 * the request gate exists to protect (`src/proxy.ts`).
 *
 * This makes that chain a dead end while leaving the report fully working. The
 * report is self-contained — inline scripts and styles, `data:` images, no
 * network fetches at all — so:
 *  - `script-src`/`style-src 'unsafe-inline'` keep the report interactive;
 *  - `connect-src 'none'` + `form-action 'none'` mean it cannot reach the API,
 *    which is the part that would turn a report XSS into an app compromise;
 *  - `default-src 'none'` denies every fetch class not named above, and
 *    `frame-ancestors 'none'` stops another page embedding it to read from it.
 *
 * It lives in its own module because `next.config.ts` is where it must actually
 * be applied: a header set in the Next config OVERRIDES one a route put on its
 * own response, so declaring it only in the route would silently lose it to the
 * baseline CSP. The route still sets it too, which keeps the policy attached to
 * the response for anyone reading that file — and makes the two impossible to
 * disagree, since both read this constant.
 */
export const HTML_REPORT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");
