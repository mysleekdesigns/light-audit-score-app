/**
 * Manual chapters 01–04: what the app is, how to start it, the first audit, and
 * how to read a score. Static server components — the manual ships as HTML.
 */

import {
  Callout,
  Code,
  DocLink,
  DocsSection,
  H3,
  LI,
  List,
  P,
  SpecList,
  Step,
  Steps,
  Terminal,
  UiLabel,
} from "@/components/docs/docs-primitives";
import { docsPlate } from "@/components/docs/sections";

export function StartChapters() {
  return (
    <>
      <DocsSection
        id="orientation"
        index={docsPlate("orientation")}
        title="What this app does"
        lede="LightAudit Score measures the quality of web pages, keeps every measurement, and helps you work out what to fix."
      >
        <P>
          Lighthouse is Google’s page-quality tool. It loads a page in a real browser and grades it
          out of 100 in five areas: how fast it feels, how usable it is for people with
          disabilities, whether it follows modern web practices, how well search engines can read
          it, and — newest of the five — how usable it is to an AI agent. LightAudit Score runs that
          tool for you — over one page or a thousand — and keeps the results.
        </P>
        <P>
          Everything happens on your own computer. There is no account, no server to sign up for,
          and no bill. The app opens in your browser only because that is a convenient way to draw
          charts; the work is done by a copy of Chrome running quietly in the background.
        </P>

        <H3>The two engines</H3>
        <P>
          The same measurements can come from two places, and the app gives you both. They answer
          different questions, so it is worth knowing which one you are looking at.
        </P>
        <SpecList
          rows={[
            {
              term: "Lighthouse",
              value: "local",
              detail: (
                <>
                  Runs on your machine, in a fresh headless Chrome. You control every dial —
                  device, throttling, how many times to repeat. Results are badged{" "}
                  <Code>LHA</Code> in History. This is the engine to use when you are changing a
                  page and want to see whether the change helped.
                </>
              ),
            },
            {
              term: "PageSpeed Insights",
              value: "Google-hosted",
              detail: (
                <>
                  Runs on Google’s servers under fixed conditions, so nothing about your laptop can
                  influence the number. It also returns{" "}
                  <strong className="font-medium text-foreground">real-world data</strong> from
                  people who actually visited the page. Results are badged <Code>PSI</Code>. Use it
                  for the number you would quote to someone else.
                </>
              ),
            },
          ]}
        />

      </DocsSection>

      <DocsSection
        id="install"
        index={docsPlate("install")}
        title="Set up and start"
        lede="Two things must already be on your machine. Everything else is one command."
      >
        <H3>What you need first</H3>
        <List>
          <LI>
            <strong className="font-medium text-foreground">Node.js version 24 or newer.</strong>{" "}
            Check with <Code>node --version</Code>. Older versions cannot run the audit engine.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Google Chrome</strong>, installed
            normally. The app finds it by itself and launches its own private copy for each audit,
            so your own browsing, tabs, extensions and logins are never touched.
          </LI>
        </List>

        <H3>Install and run</H3>
        <Terminal caption="terminal">
          {`git clone https://github.com/mysleekdesigns/light-audit-score-app.git
cd light-audit-score-app
npm install
npm start`}
        </Terminal>
        <P>
          The very first <Code>npm start</Code> builds the app, which takes about a minute. Every
          start after that takes about a second. When it is ready it prints a web address and opens
          it in your browser for you.
        </P>

        <Callout tone="warn" label="Use the printed link">
          The address includes a one-time <Code>?token=…</Code> at the end. Open{" "}
          <em>that</em> link, not a plain <Code>127.0.0.1:3000</Code> — the token is what unlocks
          the app, and opening it once remembers you on that browser. If a page ever says you are
          not authorised, go back to the terminal and click the printed link again. There is more on
          why in <DocLink href="#privacy">Privacy &amp; the local server</DocLink>.
        </Callout>

        <H3>Stopping and restarting</H3>
        <P>
          Press <Code>Ctrl</Code>+<Code>C</Code> in the terminal to stop the app. Audits only run
          while it is running — including scheduled ones. Your history is on disk, so nothing is
          lost.
        </P>

        <H3>Optional extras</H3>
        <P>
          None of these are needed to audit a page. Add them when you want the feature they unlock.
        </P>
        <SpecList
          rows={[
            {
              term: "PageSpeed key",
              value: "PAGESPEED_API_KEY",
              detail: (
                <>
                  Needed only for the PageSpeed page. Free from Google. See{" "}
                  <DocLink href="#pagespeed">PageSpeed Insights</DocLink>.
                </>
              ),
            },
            {
              term: "An AI",
              value: "Claude or Ollama",
              detail: (
                <>
                  Needed only for the “why is this score low?” analysis. See{" "}
                  <DocLink href="#ai-providers">Claude, Ollama, or your own</DocLink>.
                </>
              ),
            },
            {
              term: "Different port",
              value: "PORT=4000",
              detail: (
                <>
                  Put <Code>PORT=4000 npm start</Code> in front of the command if something else is
                  already using port 3000.
                </>
              ),
            },
          ]}
        />
        <P>
          Settings like these live in a file called <Code>.env</Code> in the project folder. Copy
          the supplied template to create it, edit it in any text editor, and restart the app
          afterwards.
        </P>
        <Terminal caption="terminal">{`cp .env.example .env`}</Terminal>
        <Callout tone="note">
          <Code>.env</Code> is where secrets go, and it is deliberately excluded from version
          control. The app only ever reads it — no page in the app will ever ask you to type a key
          into a form.
        </Callout>
      </DocsSection>

      <DocsSection
        id="first-audit"
        index={docsPlate("first-audit")}
        title="Your first audit"
        lede="Paste one address, press one button, and read the result. Six steps, about a minute."
      >
        <Steps>
          <Step title="Open the Lighthouse page">
            It is the first link in the header, and the page the app opens on.
          </Step>
          <Step title="Paste an address into Target URLs">
            One per line. It must be a full address including <Code>https://</Code> — a bare{" "}
            <Code>example.com</Code> is ignored here. Underneath, a counter confirms{" "}
            <Code>1 URL queued</Code>. If you paste a list and some lines are rejected, an amber
            note tells you exactly which line numbers were skipped.
          </Step>
          <Step title="Leave Run config alone for now">
            The defaults are sensible: a mobile phone, three repeats, three pages at a time, all
            five categories. Chapter {docsPlate("audit-settings")} explains every dial.
          </Step>
          <Step title="Press Run audit">
            The button sits at the bottom right and stays greyed out until you have at least one
            valid address.
          </Step>
          <Step title="Watch it work">
            A results panel appears, with a progress bar and one row per page moving from{" "}
            <UiLabel>Queued</UiLabel> to <UiLabel>Running</UiLabel> to <UiLabel>Done</UiLabel>. A
            single page audited three times takes roughly a minute.
          </Step>
          <Step title="Open the details">
            Click <UiLabel>View →</UiLabel> at the end of a finished row. A panel slides in with
            the five scores, the speed metrics, the list of problems Lighthouse found, and a button
            to open Google’s own full HTML report.
          </Step>
        </Steps>

        <Callout tone="tip" label="You can walk away">
          The audit keeps running if you switch to History or Settings, and even if you reload the
          page — the app reconnects to the run in progress and tells you when it finishes, whatever
          page you are on. Closing the terminal is the only thing that stops it.
        </Callout>

        <P>
          Every finished audit is saved automatically. You do not need to press save, export
          anything, or keep the tab open. Go to <DocLink href="/history">History</DocLink> and it
          is there, along with the full report file on disk.
        </P>

        <Callout tone="tip" label="Do this once, after your first run">
          Your first audit teaches the app how fast your computer is. Once it has finished, the{" "}
          <UiLabel>Calibrate</UiLabel> button on the audit form becomes available. Press it. It
          tunes the simulated-phone setting to your actual hardware, and every audit after that is
          more comparable to a real mid-range phone. See{" "}
          <DocLink href="#accuracy">Trustworthy numbers</DocLink>.
        </Callout>
      </DocsSection>

      <DocsSection
        id="reading-scores"
        index={docsPlate("reading-scores")}
        title="Reading the scores"
        lede="Five scores out of 100, six speed measurements, and a colour code used consistently everywhere in the app."
      >
        <H3>The five categories</H3>
        <SpecList
          rows={[
            {
              term: "Performance",
              value: "Perf",
              detail:
                "How quickly the page becomes visible and usable. The only score affected by how busy your computer is, and the only one that moves much between runs.",
            },
            {
              term: "Accessibility",
              value: "A11y",
              detail:
                "Whether the page works for people using screen readers, keyboards, or high-contrast settings. Automated checks only — a perfect 100 is a floor, not a certificate.",
            },
            {
              term: "Best Practices",
              value: "BP",
              detail:
                "Modern, safe web conventions: secure connections, no deprecated features, a clean browser console.",
            },
            {
              term: "SEO",
              value: "SEO",
              detail:
                "Whether search engines can find, read and index the page. Titles, descriptions, links and crawlability.",
            },
            {
              term: "Agentic Browsing",
              value: "Agent",
              detail: (
                <>
                  Whether an AI agent can read the page and act on it. The newest category, and the
                  one to read the caveats for — it is worked out from far fewer checks than the
                  others, so it moves in bigger steps. See{" "}
                  <DocLink href="#agentic-browsing">Agentic Browsing</DocLink>.
                </>
              ),
            },
          ]}
        />

        <H3>The colour bands</H3>
        <P>
          The same three bands are used on every score in the app — rings, pills, tables and
          charts.
        </P>
        <SpecList
          rows={[
            { term: "Good", value: "90–100", detail: "Green. Nothing urgent here." },
            {
              term: "Average",
              value: "50–89",
              detail: "Amber. Works, but there is room to improve.",
            },
            { term: "Poor", value: "0–49", detail: "Red. Worth attention." },
            {
              term: "Not scored",
              value: "—",
              detail:
                "An em dash means the category was switched off, the audit failed, or the run predates the category — never that the page scored zero.",
            },
          ]}
        />
        <P>
          Colour is never the only signal anywhere in this app. Every band is also written out, and
          every up-or-down arrow carries a hidden word for screen readers.
        </P>

        <H3>Core Web Vitals</H3>
        <P>
          Under the scores sit six speed measurements. Unlike the scores,{" "}
          <strong className="font-medium text-foreground">lower is better</strong> for all of them.
        </P>
        <SpecList
          rows={[
            {
              term: "LCP",
              value: "seconds",
              detail:
                "Largest Contentful Paint — when the biggest thing on screen, usually the hero image or headline, finished loading. The closest single number to “how long until it looked ready”.",
            },
            {
              term: "CLS",
              value: "0.00–1.00",
              detail:
                "Cumulative Layout Shift — how much the page jumps around while loading. The reason you tap the wrong button. Under 0.1 is good.",
            },
            {
              term: "TBT",
              value: "milliseconds",
              detail:
                "Total Blocking Time — how long the page was frozen and unable to respond to taps. This is the metric most sensitive to how busy your computer is, and it is roughly a third of the Performance score.",
            },
            {
              term: "FCP",
              value: "seconds",
              detail: "First Contentful Paint — when the first pixel of real content appeared.",
            },
            {
              term: "SI",
              value: "seconds",
              detail: "Speed Index — how quickly the page filled in visually, on average.",
            },
            {
              term: "TTI",
              value: "seconds",
              detail: "Time to Interactive — when the page reliably responded to input.",
            },
          ]}
        />

        <H3>Why the same page scores differently twice</H3>
        <P>
          Lighthouse scores wobble by roughly five points from run to run, even on an unchanged
          page. That is normal, and it is mostly Total Blocking Time reacting to whatever else your
          computer was doing. The app dampens it by auditing each page several times and reporting
          the middle result rather than the best or the average — that is what{" "}
          <em>median of 3 runs</em> means on the results panel.
        </P>
        <P>
          To see the individual runs behind a median, open a result and scroll to{" "}
          <UiLabel>Per-run spread</UiLabel>. It lists each run’s scores side by side, so you can
          tell a genuinely unstable page from a one-off blip.
        </P>

        <H3>The environment badge</H3>
        <P>
          Each result carries a small chip such as <Code>⌁ 4058 · Simulated 4×</Code>. The number is
          a measure of your computer’s speed at the moment of that run, and the rest is the
          throttling that was applied. It matters because a Performance score is only comparable to
          another one taken on similar hardware under similar settings. If the app thinks the
          machine — rather than the page — is distorting a score, it says so in an amber warning and
          offers a one-click fix.
        </P>
      </DocsSection>
    </>
  );
}
