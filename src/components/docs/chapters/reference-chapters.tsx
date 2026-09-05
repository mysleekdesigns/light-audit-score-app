/**
 * Manual chapters 17–21: the Settings panels, where files live, what the local
 * server does to stay private, and the two lists a stuck user reaches for.
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
  Terminal,
  UiLabel,
} from "@/components/docs/docs-primitives";
import { docsPlate } from "@/components/docs/sections";

export function ReferenceChapters() {
  return (
    <>
      <DocsSection
        id="settings"
        index={docsPlate("settings")}
        title="Settings"
        lede="Three panels that report what is configured. Only one of them writes anything."
      >
        <P>
          <DocLink href="/settings">Settings</DocLink> is mostly a status display. It tells you what
          the app can currently do and what it would need in order to do more. Each panel has a pill
          in its top-right corner that reads <UiLabel>Ready</UiLabel>,{" "}
          <UiLabel>Not configured</UiLabel> or <UiLabel>Needs setup</UiLabel> at a glance.
        </P>
        <SpecList
          rows={[
            {
              term: "PageSpeed key",
              value: "read-only",
              detail: (
                <>
                  Whether a Google key is present. Set it in <Code>.env</Code> and restart. See{" "}
                  <DocLink href="#pagespeed">PageSpeed Insights</DocLink>.
                </>
              ),
            },
            {
              term: "AI provider",
              value: "writable",
              detail: (
                <>
                  The one panel that saves a choice: which AI runs the analysis, and which model.
                  Takes effect immediately. See{" "}
                  <DocLink href="#ai-providers">Claude, Ollama, or your own</DocLink>.
                </>
              ),
            },
            {
              term: "Web research",
              value: "one switch",
              detail: (
                <>
                  Turns CrawlForge on or off, and reports whether a custom research server is
                  declared. See <DocLink href="#web-research">Give the AI the web</DocLink>.
                </>
              ),
            },
          ]}
        />
        <Callout tone="note" label="No key ever goes in a form">
          There is deliberately no box anywhere in the app to type an API key into. Keys live in{" "}
          <Code>.env</Code>, are read only when needed, and the app reports their presence as a
          yes-or-no. A key you can only see in a file is a key that cannot end up in a database, a
          log, or a screenshot.
        </Callout>
        <P>
          Your audit preferences — device, repeats, concurrency, categories, pass thresholds, table
          or cards — are remembered separately, in your own browser, and are restored next time you
          visit.
        </P>
      </DocsSection>

      <DocsSection
        id="data"
        index={docsPlate("data")}
        title="Where your data lives"
        lede="One folder in the project, holding everything the app has ever recorded."
      >
        <Terminal caption="project folder">
          {`data/
├── lighthouse.db      the index of every run and batch
├── reports/           the full report for each run, as .html and .json
└── session-token      the key that unlocks your local app`}
        </Terminal>
        <List>
          <LI>
            <strong className="font-medium text-foreground">Backing up</strong> means copying the{" "}
            <Code>data</Code> folder. There is nothing else.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Moving it elsewhere</strong> is{" "}
            <Code>LH_DATA_DIR</Code> in <Code>.env</Code>, or{" "}
            <Code>LH_DB_PATH</Code> for the database alone.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Deleting</strong> happens from inside
            the app — a single run in History, a scheduled run from its card, or everything at once
            with Clear history. Reports on disk are removed with the record.
          </LI>
          <LI>
            The database sets itself up on first use, so a fresh copy of the project just works. The
            folder is excluded from version control.
          </LI>
        </List>
        <P>
          Reports are the same HTML files Google’s own tools produce, so they open in any browser
          and can be sent to someone who does not have this app.
        </P>
      </DocsSection>

      <DocsSection
        id="privacy"
        index={docsPlate("privacy")}
        title="Privacy & the local server"
        lede="The app audits websites on your behalf, so it is locked to your machine and to you."
      >
        <P>
          Anything that can be asked to load arbitrary web pages is worth protecting. Four things
          keep this one to yourself, and they are on by default.
        </P>
        <List>
          <LI>
            <strong className="font-medium text-foreground">It listens only to your own machine.</strong>{" "}
            Nothing on your network can reach it.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">It checks the address you arrived by.</strong>{" "}
            Requests claiming to be for some other hostname are refused, which stops a hostile web
            page from reaching the app through your browser.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Every page needs a session token.</strong>{" "}
            Generated on first start and kept in <Code>data/session-token</Code>. The link printed
            in your terminal carries it; opening that link once remembers you.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">
              Changes are refused from other origins.
            </strong>{" "}
            Another program running on your machine cannot make this one start audits or delete
            history.
          </LI>
        </List>

        <H3>What leaves your machine</H3>
        <List>
          <LI>The pages you audit are fetched, exactly as a browser would fetch them.</LI>
          <LI>
            PageSpeed audits are requests to Google, so the addresses you audit are sent to Google.
            Local Lighthouse audits are not.
          </LI>
          <LI>
            AI analysis sends the audit data to whichever provider you chose. With Ollama that is
            your own machine and nothing leaves it at all. With Claude or a hosted endpoint, it goes
            to that service.
          </LI>
          <LI>
            There is no telemetry, no analytics, and no account. The app never reports on you to
            anyone, including its authors.
          </LI>
        </List>

        <Callout tone="warn" label="On a shared machine">
          While the app is launching your browser, the start-up link — token included — is briefly
          visible to other users of that computer. Set <Code>LH_OPEN_BROWSER=0</Code> in{" "}
          <Code>.env</Code> to skip the automatic launch, and open the app yourself. You can also
          pin your own token with <Code>LH_SESSION_TOKEN</Code> if it is at least 32 characters.
        </Callout>
        <P>
          If you deliberately bind the app to a wider address, you must also list the hostnames you
          will use in <Code>LH_ALLOWED_HOSTS</Code>. That is a considered decision rather than a
          convenience, and the loopback default is the right choice for almost everyone.
        </P>
      </DocsSection>

      <DocsSection
        id="troubleshooting"
        index={docsPlate("troubleshooting")}
        title="Troubleshooting"
        lede="The problems people actually hit, and what fixes each one."
      >
        <SpecList
          rows={[
            {
              term: "Not authorised",
              detail: (
                <>
                  The session cookie is missing or was cleared. Go back to the terminal and open the
                  printed <Code>?token=…</Code> link again.
                </>
              ),
            },
            {
              term: "PageSpeed fails",
              detail: (
                <>
                  Almost always a missing key — the anonymous quota is zero, so it fails instantly.
                  Add <Code>PAGESPEED_API_KEY</Code> and restart. If the key is set and it still
                  fails, the PageSpeed Insights API is probably not enabled on that key’s Google
                  Cloud project.
                </>
              ),
            },
            {
              term: "Rate limited",
              detail:
                "Too many requests at once for Google’s per-minute burst. Lower runs per URL or concurrency, or split the batch. The counter on the form warns you before you start.",
            },
            {
              term: "“Bring your own AI”",
              detail: (
                <>
                  No analysis provider is set up. Open{" "}
                  <DocLink href="/settings">Settings</DocLink> and pick one — see{" "}
                  <DocLink href="#ai-providers">chapter {docsPlate("ai-providers")}</DocLink>.
                </>
              ),
            },
            {
              term: "Claude not logged in",
              detail: (
                <>
                  Run <Code>claude login</Code> in a terminal, or set an{" "}
                  <Code>ANTHROPIC_API_KEY</Code> in <Code>.env</Code> and restart.
                </>
              ),
            },
            {
              term: "Ollama not running",
              detail: (
                <>
                  Start it with <Code>ollama serve</Code>. If it listens somewhere other than the
                  default, set <Code>OLLAMA_BASE_URL</Code>. If it is running but the model list is
                  empty, pull a model first.
                </>
              ),
            },
            {
              term: "Analysis has no sources",
              detail: (
                <>
                  Expected unless you are on Claude with a research server connected. See{" "}
                  <DocLink href="#web-research">Give the AI the web</DocLink>.
                </>
              ),
            },
            {
              term: "Scores lower than expected",
              detail: (
                <>
                  Usually concurrency. Several audits at once compete for your processor and push
                  Performance down. Turn on accuracy mode and re-run. Also check the environment
                  badge and press <UiLabel>Calibrate</UiLabel>.
                </>
              ),
            },
            {
              term: "Disagrees with Chrome",
              detail: (
                <>
                  Press <UiLabel>Match DevTools</UiLabel>, and run Chrome’s panel in an incognito
                  window so its own extensions do not skew Best Practices.
                </>
              ),
            },
            {
              term: "Crawl found nothing",
              detail: (
                <>
                  Raise the depth, make sure both discovery sources are on, and check the
                  discovery notes — the site’s <Code>robots.txt</Code> may forbid crawling. A
                  sitemap-only result is still usable.
                </>
              ),
            },
            {
              term: "A site blocks the audit",
              detail:
                "Some sites reject unfamiliar browsers. Set the user agent to Desktop Chrome or Mobile Chrome so the audit looks like an ordinary visitor.",
            },
            {
              term: "Port already in use",
              detail: (
                <>
                  Start with a different one: <Code>PORT=4000 npm start</Code>.
                </>
              ),
            },
            {
              term: "Won’t start after an update",
              detail: (
                <>
                  Check <Code>node --version</Code> is 24 or newer. If the error mentions the
                  database module, run <Code>npm run rebuild:node</Code>.
                </>
              ),
            },
            {
              term: "Schedule never fired",
              detail:
                "The app must be running at the scheduled time. It catches up on the next start if the day’s window has passed unfired.",
            },
            {
              term: "Only some reports opened",
              detail:
                "Your browser’s pop-up blocker. Allow pop-ups for this address, or open reports one at a time.",
            },
          ]}
        />
      </DocsSection>

      <DocsSection
        id="faq"
        index={docsPlate("faq")}
        title="Questions"
        lede="Short answers to the things people ask before they trust the numbers."
      >
        <H3>Are these real Lighthouse scores?</H3>
        <P>
          Yes. The app runs the same Lighthouse engine that powers PageSpeed Insights and Chrome’s
          built-in panel. The difference is where it runs and what you are allowed to configure.
        </P>

        <H3>Why did the score change when nothing changed?</H3>
        <P>
          Normal variance of about five points, mostly from Total Blocking Time reacting to how busy
          your machine was. That is what auditing several times and taking the middle result is for.
          See <DocLink href="#reading-scores">Reading the scores</DocLink>.
        </P>

        <H3>Which engine should I quote?</H3>
        <P>
          PageSpeed, because your hardware plays no part in it and it includes real visitors. Use
          local Lighthouse while you are working, when you want fast feedback and full control.
        </P>

        <H3>Does any of this cost money?</H3>
        <P>
          The app is free and the PageSpeed key is free. The only possible cost is the AI you choose
          for analysis, and Ollama makes even that free. Nothing is ever billed by this app, because
          it holds no credentials of its own.
        </P>

        <H3>Can I audit a site that is not public?</H3>
        <P>
          Anything your machine can reach, including a local development server. Pages behind a login
          will be audited as a logged-out visitor sees them.
        </P>

        <H3>How many pages can one batch hold?</H3>
        <P>
          Up to ten thousand. Long before that, use <UiLabel>Pages / template</UiLabel> to sample a
          few representative pages per pattern instead of auditing every product page on a shop.
        </P>

        <H3>Is my data sent anywhere?</H3>
        <P>
          Not by the app itself. See <DocLink href="#privacy">Privacy &amp; the local server</DocLink>{" "}
          for exactly what leaves your machine and when.
        </P>

        <H3>Where do I start?</H3>
        <P>
          <DocLink href="/">Run an audit</DocLink> on one page, press{" "}
          <UiLabel>Calibrate</UiLabel> when it finishes, then ask the AI why the lowest score is
          low.
        </P>
      </DocsSection>
    </>
  );
}
