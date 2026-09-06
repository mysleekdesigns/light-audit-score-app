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

/**
 * The Content-Security-Policy for the CLIENT-READY report export (ROADMAP Phase H).
 *
 * `POST /api/export/batch/:batchId` also answers with a whole HTML document built
 * from an audited page's data, so it needs the same treatment as the Lighthouse
 * report above — but not the same policy, and the difference is the point.
 *
 * {@link HTML_REPORT_CSP} grants `script-src 'unsafe-inline'` because the
 * standalone Lighthouse report is INTERACTIVE: its inline script is what makes
 * the audit sections expand. The client report is not. It ships no `<script>` at
 * all, by design — every state it has is expressed in CSS, and `<details>`
 * elements do the one thing a reader can toggle — so granting inline script on
 * that path would advertise a capability the document neither uses nor wants.
 *
 * Nothing can execute there today either way: the document carries its own
 * `<meta>` policy (`REPORT_META_CSP` in `@/lib/export/report-html`) whose
 * `default-src 'none'` covers scripts, and where two policies apply a resource
 * must satisfy BOTH, so the stricter one decides. This constant exists so the
 * response header and the document agree rather than the header being quietly
 * the laxer of the two — a reader comparing them should not have to work out
 * which one is load-bearing, and a future change to the document should not be
 * able to start executing script merely because the transport allowed it.
 *
 * It is the meta policy plus `frame-ancestors 'none'`, which a `<meta>` policy
 * cannot express and only a header can. (A `<meta>` CSP silently ignores
 * `frame-ancestors`, `report-uri` and `sandbox`, so the two are not duplicates —
 * copying the document's policy verbatim would have dropped the one protection
 * only a header can carry.)
 *
 * **Be honest about this header's reach: it covers the SERVED response and
 * nothing after it.** The document is sent `Content-Disposition: attachment`, so
 * its actual life is spent on `file://` on someone else's machine, where there
 * is no response header at all and the `<meta>` policy is the only one in play.
 * That makes the meta the load-bearing half and this header the narrow case —
 * the opposite of the usual arrangement, and worth knowing before anyone decides
 * this constant is what keeps the exported file inert. It is not. Escaping is
 * primary (a sanitising viewer, a webmail preview pane, may strip `<meta>` and
 * everything else outside `<body>`, leaving neither policy); the meta is the
 * defence in depth that travels with the file; this is defence in depth for the
 * seconds the document exists on the app's own origin.
 */
export const CLIENT_REPORT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");
