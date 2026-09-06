/**
 * The exported client report's entire stylesheet, as one string (ROADMAP Phase H).
 *
 * WHY A TS MODULE AND NOT A `.css` FILE
 * -------------------------------------
 * The report is ONE file. Every byte a reader needs has to be inside the document
 * the renderer returns, because the file is emailed to a client and opened with
 * the network disabled — a `<link rel="stylesheet">` would render as an unstyled
 * dump on the one machine we cannot test. A real `.css` file would either be
 * extracted into a separate asset by the bundler or need `node:fs` to read back,
 * and `report-html.ts` is deliberately pure (see the seam note on
 * `./report-model.ts`). A string constant is the only form that is guaranteed to
 * survive into the output, and it keeps the renderer unit-testable from a literal.
 *
 * TYPOGRAPHY: SYSTEM STACKS, ON PURPOSE
 * -------------------------------------
 * The app itself is set in Archivo + JetBrains Mono, both loaded over the network
 * by `next/font`. Neither can come here: a webfont is a network request, and
 * embedding a font binary as a `data:` URI would add hundreds of KB per face to a
 * file whose whole premise is that it is small enough to attach to an email — and
 * would mean shipping a redistributed font we do not license for that.
 *
 * So the identity is carried by TREATMENT rather than by an exotic face: uppercase
 * monospace micro-labels at 0.18em tracking, hairline rules that run to the edge
 * of every section, tabular figures on every number, the faint instrument grid,
 * and the signal-cyan accent held apart from the red/orange/green score
 * semantics. The stacks pick the most refined face each platform actually has —
 * `ui-sans-serif` resolves to SF Pro / Segoe UI Variable, and the mono stack names
 * JetBrains Mono first so a developer who already has it installed gets the
 * product's real face for free.
 *
 * TOKENS: THE SAME ONES THE APP USES
 * ----------------------------------
 * The dark palette is `.dark` from `src/app/globals.css`, hand-copied as plain
 * custom properties (this file cannot `@import` Tailwind). Each token is declared
 * twice — an sRGB hex first, then the identical oklch — so a browser too old for
 * oklch drops the second declaration and still gets the right colour rather than
 * an unstyled document. That belt-and-braces matters more here than in the app,
 * because we do not control the machine the file is opened on.
 *
 * PRINT IS A SEPARATE, INK-SANE RENDERING OF THE SAME TOKENS
 * ---------------------------------------------------------
 * The dark console look is the product's identity and stays on screen. Printing it
 * would empty a toner cartridge for one report, so `@media print` re-declares every
 * custom property as a light palette: white ground, near-black text, hairline
 * greys, and score colours darkened until they are legible on paper AND separated
 * in GREYSCALE (their relative luminances are roughly 10 L* apart, so a
 * black-and-white printer still tells good from average from poor). Colour is never
 * the only signal anywhere — every band also carries a word.
 */

/**
 * Font stacks, factored out so the two families are declared once and the
 * rationale above has something to point at.
 */
const FONT_SANS =
  'ui-sans-serif, -apple-system, "Segoe UI Variable Text", "Segoe UI", ' +
  '"Helvetica Neue", Roboto, "Liberation Sans", Arial, sans-serif';

const FONT_MONO =
  'ui-monospace, "JetBrains Mono", "SF Mono", SFMono-Regular, "Cascadia Mono", ' +
  '"Segoe UI Mono", Menlo, Consolas, "Liberation Mono", monospace';

export const REPORT_CSS = `
/* ========================================================================== */
/* Tokens — the app's .dark palette, hex first then oklch (see module note).   */
/* ========================================================================== */

:root {
  color-scheme: dark;

  --font-sans: ${FONT_SANS};
  --font-mono: ${FONT_MONO};

  --bg: #0c0f11;
  --bg: oklch(0.165 0.006 240);
  --surface: #14181a;
  --surface: oklch(0.205 0.007 240);
  --surface-2: #212528;
  --surface-2: oklch(0.26 0.008 240);
  --fg: #eff2f4;
  --fg: oklch(0.96 0.004 240);
  --fg-muted: #9aa1a7;
  --fg-muted: oklch(0.705 0.012 240);

  /* Two weights of rule: --border draws a card edge, --hairline divides rows. */
  --border: #262b2e;
  --hairline: #1d2225;
  /* The instrument grid on the page ground. Barely-there by design. */
  --grid: #ffffff0a;

  /* Signal cyan. Deliberately NOT any of the three score colours, so "this is
     the product's accent" and "this score is fine" can never be confused. */
  --accent: #34dde5;
  --accent: oklch(0.82 0.13 200);
  --accent-dim: #1e3234;
  --accent-dim: oklch(0.3 0.025 205);

  --good: #14ca80;
  --good: oklch(0.74 0.17 158);
  --average: #f5af20;
  --average: oklch(0.8 0.16 78);
  --poor: #fc4540;
  --poor: oklch(0.66 0.22 27);

  /* Chip fills / edges as 8-digit hex rather than color-mix(), which is a newer
     feature than oklch and would leave a chip with no fill where oklch would
     only have fallen back to its hex twin. */
  --good-tint: #14ca8021;
  --good-edge: #14ca804d;
  --average-tint: #f5af2021;
  --average-edge: #f5af204d;
  --poor-tint: #fc454021;
  --poor-edge: #fc45404d;
  --none: #9aa1a7;
  --none-tint: #ffffff0f;
  --none-edge: #ffffff26;

  --radius: 8px;
  --radius-sm: 4px;
}

/* ========================================================================== */
/* Reset + base                                                               */
/* ========================================================================== */

*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
  /* An #run-… jump should not land the page heading hard against the viewport. */
  scroll-padding-top: 2rem;
}

body {
  margin: 0;
  padding: 0;
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.55;
  color: var(--fg);
  background-color: var(--bg);
  /* Faint instrument grid — the same 48px lattice the app draws on its body. */
  background-image:
    linear-gradient(to right, var(--grid) 1px, transparent 1px),
    linear-gradient(to bottom, var(--grid) 1px, transparent 1px);
  background-size: 48px 48px;
  background-position: center top;
}

h1, h2, h3, h4 {
  margin: 0;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.01em;
  /* Both are progressive: an engine that does not know them just wraps normally. */
  text-wrap: balance;
}

p {
  margin: 0;
  text-wrap: pretty;
}
ul, ol { margin: 0; padding: 0; list-style: none; }

img {
  max-width: 100%;
  display: block;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}

a {
  color: var(--accent);
  text-decoration-color: var(--accent-edge, currentColor);
  text-underline-offset: 0.2em;
}

a:hover {
  text-decoration-thickness: 2px;
}

/* One focus treatment for the whole document. The only focusable things here
   are <summary> elements, in-document anchors and the scrollable table regions,
   and every one of them needs a ring a keyboard reader can actually see. */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

/* ========================================================================== */
/* Typographic utilities                                                      */
/* ========================================================================== */

/* The report's signature micro-label: mono, uppercase, widely tracked. Used for
   every eyebrow, column header and unit caption. */
.eyebrow {
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--fg-muted);
}

.mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.num {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}

/* Text a screen reader should read and nobody should see — table captions,
   mostly, which give each data table a name without repeating the heading. */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* Page-authored URLs are printed as text and never linked. They can be very
   long, so they wrap anywhere rather than forcing a horizontal scrollbar. */
.url {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* ========================================================================== */
/* Shell                                                                      */
/* ========================================================================== */

.report {
  max-width: 62rem;
  margin: 0 auto;
  padding: 2.5rem 1.5rem 4rem;
  display: flex;
  flex-direction: column;
  gap: 2.5rem;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* Section heading + a hairline that runs to the right edge, with an optional
   figure parked at the end of it. The instrument-panel move that gives the whole
   document its rhythm. */
.section-head {
  display: flex;
  align-items: center;
  gap: 0.875rem;
}

.section-head h2 {
  font-size: 0.9375rem;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.section-head .rule {
  flex: 1 1 auto;
  height: 1px;
  min-width: 1rem;
  background: var(--border);
}

.section-meta {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fg-muted);
  white-space: nowrap;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

/* ========================================================================== */
/* Masthead — optional branding block + the report's own identity             */
/* ========================================================================== */

.masthead {
  position: relative;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.75rem 1.75rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* Corner ticks: two short cyan rules meeting at the top-left, the way a bezel
   marks the origin of a gauge. Purely decorative, so they are hidden from AT by
   being pseudo-elements with no content. */
.masthead::before,
.masthead::after {
  content: "";
  position: absolute;
  background: var(--accent);
  opacity: 0.7;
}

.masthead::before {
  top: -1px;
  left: -1px;
  width: 2.25rem;
  height: 2px;
}

.masthead::after {
  top: -1px;
  left: -1px;
  width: 2px;
  height: 2.25rem;
}

.brand {
  display: flex;
  align-items: flex-start;
  gap: 1.25rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--hairline);
}

.brand-logo {
  flex: 0 0 auto;
  max-height: 3.5rem;
  max-width: 12rem;
  width: auto;
  object-fit: contain;
}

.brand-text {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}

.brand-title {
  font-size: 1.125rem;
  letter-spacing: -0.015em;
}

.brand-subtitle {
  font-size: 0.875rem;
  color: var(--fg-muted);
}

.brand-date {
  margin-left: auto;
  flex: 0 0 auto;
  text-align: right;
}

.report-id {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.report-id h1 {
  font-size: 1.75rem;
  letter-spacing: -0.025em;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.6rem;
}

/* The batch id reads as an instrument serial number, not as prose. */
.batch-id {
  font-family: var(--font-mono);
  font-size: 0.9375rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--accent);
  background: var(--accent-dim);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.1rem 0.5rem;
}

/* Provenance: a definition list, because "Throttling → Simulated" is exactly
   what a <dl> is for, and it prints as a clean key/value strip. */
.provenance {
  margin: 0.25rem 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 2rem;
}

.provenance > div {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.provenance dt {
  font-family: var(--font-mono);
  font-size: 0.625rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--fg-muted);
}

.provenance dd {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
}

/* ========================================================================== */
/* Score rings                                                                */
/* ========================================================================== */

.rings {
  display: flex;
  flex-wrap: wrap;
  gap: 1.25rem 1.75rem;
  align-items: flex-start;
}

.ring {
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  min-width: 4.5rem;
}

.ring-gauge {
  width: 84px;
  height: 84px;
  display: block;
}

/* The page cards run the same gauge at a smaller size — one geometry, scaled by
   the SVG viewBox, so a ring can never drift between the two contexts. */
.page-card .ring-gauge {
  width: 58px;
  height: 58px;
}

.ring-track {
  fill: none;
  stroke: var(--border);
  stroke-width: 6;
  stroke-linecap: round;
}

/* An unscored gauge gets a dotted track and no arc — visibly "no reading taken"
   rather than a ring sitting at zero, which would read as a score of 0. */
.ring--none .ring-track {
  stroke-dasharray: 1 7;
}

.ring-arc {
  fill: none;
  stroke-width: 6;
  stroke-linecap: round;
  /* Explicit per-band stroke (not currentColor) so the print palette's redefined
     --good/--average/--poor reach the arc directly. */
  stroke: var(--none);
}

.ring--good .ring-arc { stroke: var(--good); }
.ring--average .ring-arc { stroke: var(--average); }
.ring--poor .ring-arc { stroke: var(--poor); }

.ring-value {
  font-family: var(--font-mono);
  font-size: 20px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  text-anchor: middle;
  dominant-baseline: central;
  fill: var(--none);
}

.ring--good .ring-value { fill: var(--good); }
.ring--average .ring-value { fill: var(--average); }
.ring--poor .ring-value { fill: var(--poor); }

.ring-caption {
  font-family: var(--font-mono);
  font-size: 0.625rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--fg-muted);
  text-align: center;
}

/* ========================================================================== */
/* Stat tiles                                                                 */
/* ========================================================================== */

/*
 * Cell dividers are BORDERS ON THE CELLS, not the usual "1px grid gap over a
 * border-coloured container". The gap trick is neater until a row is partial —
 * six metrics in a five-column track leaves the container's own background
 * showing through as a grey slab, which reads as a rendering fault rather than
 * as empty space. With the container painted in the surface colour, an unused
 * cell is simply unused.
 */
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.tile {
  padding: 1rem 1.125rem;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.tile-value {
  font-family: var(--font-mono);
  font-size: 1.5rem;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  line-height: 1.1;
}

.tile-label {
  font-family: var(--font-mono);
  font-size: 0.625rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--fg-muted);
}

.tile-note {
  font-size: 0.75rem;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

/* ========================================================================== */
/* Chips — every one carries a WORD, never colour alone                       */
/* ========================================================================== */

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-family: var(--font-mono);
  font-size: 0.625rem;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 0.15rem 0.45rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--none-edge);
  background: var(--none-tint);
  color: var(--fg-muted);
  white-space: nowrap;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.chip--good {
  color: var(--good);
  background: var(--good-tint);
  border-color: var(--good-edge);
}

.chip--average {
  color: var(--average);
  background: var(--average-tint);
  border-color: var(--average-edge);
}

.chip--poor {
  color: var(--poor);
  background: var(--poor-tint);
  border-color: var(--poor-edge);
}

.chip--accent {
  color: var(--accent);
  background: var(--accent-dim);
  border-color: var(--border);
}

/* ========================================================================== */
/* Data tables                                                                */
/* ========================================================================== */

/* A wide table scrolls inside its own box so the document body never gains a
   horizontal scrollbar. tabindex="0" on the wrapper is what lets a keyboard-only
   reader scroll it at all. */
.table-scroll {
  overflow-x: auto;
  overscroll-behavior-x: contain;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.data thead th {
  font-family: var(--font-mono);
  font-size: 0.625rem;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fg-muted);
  text-align: left;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.data tbody td {
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--hairline);
  vertical-align: top;
}

.data tbody tr:last-child td {
  border-bottom: 0;
}

.data .col-num {
  text-align: right;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.data th.col-num {
  text-align: right;
}

/* ========================================================================== */
/* Summary: pass/fail bar                                                     */
/* ========================================================================== */

.passbar {
  display: flex;
  width: 6rem;
  height: 0.5rem;
  border-radius: 999px;
  overflow: hidden;
  background: var(--none-tint);
  border: 1px solid var(--none-edge);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.passbar-pass {
  background: var(--good);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.passbar-fail {
  background: var(--poor);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* Best / worst highlight pair. */
.highlights {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 1rem;
}

.highlight {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.875rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.highlight-score {
  font-family: var(--font-mono);
  font-size: 1.25rem;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.highlight--best .highlight-score { color: var(--good); }
.highlight--worst .highlight-score { color: var(--poor); }

/* ========================================================================== */
/* Page cards                                                                 */
/* ========================================================================== */

.pages {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.page-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  /* A #run-… jump must not put the card's own heading under the viewport edge. */
  scroll-margin-top: 1.5rem;
}

.page-card[open] > .page-head {
  border-bottom: 1px solid var(--hairline);
}

.page-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem 0.875rem;
  padding: 0.875rem 1.125rem;
  cursor: pointer;
  list-style: none;
  /* The one tappable element in the document: skip the 300ms double-tap wait,
     and let the hover/focus styles below be the feedback rather than a grey
     flash the theme never asked for. */
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.page-head:hover {
  background: var(--surface-2);
}

/* Both spellings are needed: WebKit still uses the pseudo-element, everyone else
   honours list-style on the summary box. */
.page-head::-webkit-details-marker { display: none; }
.page-head::marker { content: ""; }

/* Our own disclosure caret, drawn in CSS so the document needs no icon asset. */
.page-head::before {
  content: "";
  flex: 0 0 auto;
  width: 0;
  height: 0;
  border-left: 5px solid var(--fg-muted);
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
}

.page-card[open] > .page-head::before {
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid var(--fg-muted);
  border-bottom: 0;
}

.page-title {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  min-width: 0;
  flex: 1 1 18rem;
  font-size: 0.9375rem;
  font-weight: 500;
}

.page-index {
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.1em;
  color: var(--accent);
  flex: 0 0 auto;
}

.page-flags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  flex: 0 0 auto;
}

.page-body {
  padding: 1.25rem 1.125rem 1.375rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.page-body h4 {
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--fg-muted);
  margin-bottom: 0.625rem;
}

.page-fact {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1.25rem;
  font-size: 0.75rem;
  color: var(--fg-muted);
}

/* Each fact reads as one unit, so it wraps between facts rather than inside
   one — except a URL, which is long enough that it has to break somewhere. */
.page-fact > span {
  white-space: nowrap;
}

.page-fact .url {
  font-size: 0.75rem;
  white-space: normal;
}

/* A failure gets a bordered block, not a red word buried in a paragraph. */
.error-box {
  border: 1px solid var(--poor-edge);
  background: var(--poor-tint);
  border-radius: var(--radius);
  padding: 0.75rem 0.875rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.error-box .eyebrow { color: var(--poor); }

.error-message {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}

/* ========================================================================== */
/* Core Web Vitals grid                                                       */
/* ========================================================================== */

/* Same divider discipline as .tiles — see the note there. */
.cwv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.metric {
  padding: 0.75rem 0.875rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}

.metric-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}

.metric-abbr {
  font-family: var(--font-mono);
  font-size: 0.625rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--fg-muted);
}

.metric-value {
  font-family: var(--font-mono);
  font-size: 1.125rem;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  color: var(--none);
  min-width: 0;
  overflow-wrap: anywhere;
}

.metric--good .metric-value { color: var(--good); }
.metric--average .metric-value { color: var(--average); }
.metric--poor .metric-value { color: var(--poor); }

.metric-label {
  font-size: 0.6875rem;
  color: var(--fg-muted);
}

/* The band WORD. Set in the band's own colour and tracked like every other
   verdict in the document, so a reader gets the same answer from the text as
   from the colour — and the same answer in greyscale. */
.metric-band {
  font-family: var(--font-mono);
  font-size: 0.5625rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--none);
}

.metric--good .metric-band { color: var(--good); }
.metric--average .metric-band { color: var(--average); }
.metric--poor .metric-band { color: var(--poor); }

/* ========================================================================== */
/* Opportunities                                                              */
/* ========================================================================== */

.opp-title {
  font-weight: 500;
  font-size: 0.8125rem;
}

.opp-desc {
  margin-top: 0.2rem;
  font-size: 0.75rem;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

/* ========================================================================== */
/* Filmstrip                                                                  */
/* ========================================================================== */

.filmstrip-box {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  overflow: hidden;
}

.filmstrip {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem;
  overflow-x: auto;
  overscroll-behavior-x: contain;
}

.frame {
  flex: 0 0 auto;
  width: 6rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.frame img {
  width: 100%;
  height: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

/* The LCP frame is marked with a cyan edge AND an "LCP" chip — the chip is what
   carries the meaning; the edge only makes it findable at a glance. */
.frame--lcp img {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.frame-caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.3rem;
  font-family: var(--font-mono);
  font-size: 0.625rem;
  font-variant-numeric: tabular-nums;
  color: var(--fg-muted);
}

.frame-flag {
  font-family: var(--font-mono);
  font-size: 0.5625rem;
  letter-spacing: 0.1em;
  color: var(--accent);
}

.frame-missing {
  width: 100%;
  aspect-ratio: 3 / 5;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
  font-size: 0.5625rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-muted);
  text-align: center;
  padding: 0.25rem;
}

/* ========================================================================== */
/* Waterfall                                                                  */
/* ========================================================================== */

.wf-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.75rem;
  margin-bottom: 0.5rem;
}

.wf .col-track {
  width: 38%;
  min-width: 8rem;
}

/* The track has to be VISIBLE, not merely present. Most requests on a
   multi-second timeline are a couple of percent wide, so without a drawn axis
   behind them the column reads as a scattering of dots rather than as "this
   request happened here, in a load this long". The border (rather than a
   box-shadow) is deliberate: box-shadows are routinely dropped when printing. */
/*
 * DISPLAY: BLOCK IS LOAD-BEARING, not tidiness.
 *
 * The track is a <span> with no text in it, and CSS does not apply width,
 * height or vertical padding to a non-replaced INLINE box. Left inline it
 * computes to 0x0 — and because the bar is absolutely positioned inside it,
 * every bar then resolves its left/width percentages against a zero-width
 * containing block and collapses to a 2px dot pinned to the left of the cell,
 * in both screen and print. The geometry maths is fine when that happens, which
 * is what makes the failure so quiet: the emitted percentages are correct and
 * the rendering is nonsense. The explicit width says the same thing twice on
 * purpose, so a later change to display can never silently take the size away.
 */
.wf-track {
  position: relative;
  display: block;
  width: 100%;
  height: 0.75rem;
  min-width: 4rem;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* The bar carries a border as well as a fill so it survives a printer that has
   dropped background colours — an outlined bar in the right place still reads
   as a timing, an invisible one reads as missing data. The pixel floor backs up
   MIN_BAR_PCT: on a narrow track even 0.8% can round below a device pixel. */
.wf-bar {
  position: absolute;
  top: 0;
  height: 100%;
  min-width: 3px;
  border-radius: 999px;
  background: var(--accent);
  border: 1px solid var(--accent);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.wf-bar--blocking {
  background: var(--poor);
  border-color: var(--poor);
}

.wf-bar--third-party {
  background: var(--average);
  border-color: var(--average);
}

.wf-bar--first-party {
  background: var(--accent);
  border-color: var(--accent);
}

.wf-marks {
  display: inline-flex;
  gap: 0.25rem;
  margin-left: 0.35rem;
  vertical-align: middle;
}

.wf-no-bar {
  font-family: var(--font-mono);
  font-size: 0.625rem;
  color: var(--fg-muted);
}

.wf-host {
  color: var(--fg-muted);
}

/* ========================================================================== */
/* Notes, empty states, footer                                                */
/* ========================================================================== */

.notes {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.notes li {
  position: relative;
  padding-left: 1rem;
  font-size: 0.8125rem;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

.notes li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.55em;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--accent);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* Every "there is nothing here" in the document uses this, so an absence always
   looks deliberate and never like a rendering failure. */
.empty {
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  font-size: 0.8125rem;
  color: var(--fg-muted);
  text-align: center;
}

.omission {
  font-size: 0.75rem;
  color: var(--fg-muted);
  border-left: 2px solid var(--border);
  padding-left: 0.75rem;
}

.footer {
  border-top: 1px solid var(--border);
  padding-top: 1.25rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1.5rem;
  align-items: baseline;
  font-size: 0.75rem;
  color: var(--fg-muted);
}

.footer strong {
  color: var(--fg);
  font-weight: 600;
}

/* ========================================================================== */
/* Narrow screens                                                             */
/* ========================================================================== */

@media (max-width: 640px) {
  .report {
    padding: 1.5rem 1rem 3rem;
    gap: 2rem;
  }

  .report-id h1 { font-size: 1.375rem; }

  .brand {
    flex-wrap: wrap;
  }

  .brand-date {
    margin-left: 0;
    text-align: left;
    width: 100%;
  }

  .rings {
    gap: 1rem 1.25rem;
  }

  .ring-gauge {
    width: 68px;
    height: 68px;
  }
}

/* ========================================================================== */
/* Print — the same tokens, rendered for ink                                  */
/* ========================================================================== */

@page {
  margin: 14mm 12mm;
}

@media print {
  :root {
    color-scheme: light;

    --bg: #ffffff;
    --surface: #ffffff;
    --surface-2: #f5f6f8;
    --fg: #12161a;
    --fg-muted: #4d545c;
    --border: #ccd2d8;
    --hairline: #e4e8ec;
    --grid: transparent;

    --accent: #0e5c66;
    --accent-dim: #eef4f5;

    /* Darkened until each clears 5:1 on white AND the three sit roughly 10 L*
       apart from one another, so a greyscale printer still separates them.
       Every band is also labelled in words, so this is reinforcement only. */
    --good: #0a4d2c;
    --average: #9c6100;
    --poor: #b01a12;

    --good-tint: #e8f3ed;
    --good-edge: #0a4d2c;
    --average-tint: #fbf1de;
    --average-edge: #9c6100;
    --poor-tint: #fbeae9;
    --poor-edge: #b01a12;
    --none: #4d545c;
    --none-tint: #f2f3f5;
    --none-edge: #ccd2d8;
  }

  body {
    font-size: 10.5pt;
    line-height: 1.45;
    background-color: #ffffff;
    /* The instrument grid is a screen texture; on paper it is 48px of wasted
       toner behind every line of text. */
    background-image: none;
  }

  .report {
    max-width: none;
    padding: 0;
    gap: 1.5rem;
  }

  /* Decorative bezel ticks earn nothing on paper. */
  .masthead::before,
  .masthead::after {
    display: none;
  }

  .masthead,
  .card,
  .page-card,
  .highlight,
  .tiles,
  .cwv,
  .table-scroll,
  .filmstrip-box {
    box-shadow: none;
  }

  /* A page's readout should not be split across a sheet boundary if it fits. */
  .page-card,
  .highlight,
  .tile,
  .metric,
  .frame,
  .error-box {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .section-head {
    break-after: avoid;
    page-break-after: avoid;
  }

  /* A waterfall can run over a page boundary; its header must come with it. */
  thead {
    display: table-header-group;
  }

  tr {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  /* Force every collapsible page open.
     Three rules because there are three generations of <details> in the wild:
     the modern ::details-content pseudo-element, older Chromium's hidden slot,
     and everything else that simply honours display on the children. A reader
     who deliberately collapsed a section before printing may still see it
     collapsed in the oldest engines — the markup ships with an "open" attribute set, so this
     only has to cover a manual collapse. */
  details::details-content {
    content-visibility: visible !important;
    block-size: auto !important;
  }

  details:not([open]) > *:not(summary) {
    display: block !important;
  }

  .page-head {
    cursor: auto;
  }

  .page-head::before {
    display: none;
  }

  /* Nothing scrolls on paper; a clipped table would silently lose columns. */
  .table-scroll,
  .filmstrip {
    overflow: visible !important;
  }

  .filmstrip {
    flex-wrap: wrap;
  }

  .frame {
    width: 4.5rem;
  }

  .ring-gauge {
    width: 66px;
    height: 66px;
  }

  .page-card .ring-gauge {
    width: 48px;
    height: 48px;
  }

  /* Fills that mean something (score chips, waterfall bars, the pass/fail bar)
     opt into being printed; everything else can safely drop to white. */
  .chip,
  .wf-track,
  .wf-bar,
  .passbar,
  .passbar-pass,
  .passbar-fail,
  .error-box,
  .notes li::before {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}
`;
