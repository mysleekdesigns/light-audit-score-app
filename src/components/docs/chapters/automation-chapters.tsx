/**
 * Manual chapters 19–20: the two ways the engine runs with nobody watching —
 * as a build gate with an exit code, and as an MCP server a coding agent
 * drives while you work.
 *
 * They share a group because they share a claim: neither needs the app to be
 * running, and both write into the same archive the UI reads. That shared
 * archive is the whole reason either is worth using here rather than in a
 * throwaway container, so each chapter says it plainly.
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
} from "@/components/docs/docs-primitives";
import { docsPlate } from "@/components/docs/sections";

export function AutomationChapters() {
  return (
    <>
      <DocsSection
        id="ci"
        index={docsPlate("ci")}
        title="Budgets in CI"
        lede="The same engine as a build gate. Give it some pages and a bar, and it exits 0 when they all clear it and 1 when one doesn’t."
      >
        <P>
          No server, no session token, no browser window to look at — one command that audits and
          then tells your pipeline whether to go green. Chrome still launches, headless, because
          that is what an audit is.
        </P>
        <Terminal caption="terminal">
          {`npm run ci -- https://example.com https://example.com/pricing --budget 90`}
        </Terminal>
        <Terminal caption="a failing build">
          {`✗ 2 budget violation(s) across 1 of 2 page(s):
  https://example.com/pricing [mobile]
      performance 71 < 90
      seo 88 < 90`}
        </Terminal>

        <H3>Choosing the pages</H3>
        <SpecList
          rows={[
            {
              term: "URLs",
              value: "positional",
              detail: "One or more addresses straight on the command line.",
            },
            {
              term: "A file of URLs",
              value: "--urls-file",
              detail: (
                <>
                  One address per line. Blank lines and lines starting with <Code>#</Code> are
                  ignored, so the file can carry comments.
                </>
              ),
            },
            {
              term: "A crawl",
              value: "--crawl",
              detail: (
                <>
                  Discover the pages from a seed, the same crawler the app uses, bounded by{" "}
                  <Code>--max-pages</Code>, <Code>--max-depth</Code>, <Code>--no-sitemap</Code>,{" "}
                  <Code>--no-follow-links</Code> and <Code>--exclude-paths</Code>.
                </>
              ),
            },
          ]}
        />
        <P>
          All three compose into one list. The audit dials are the ones the form has —{" "}
          <Code>--runs</Code>, <Code>--device</Code>, <Code>--throttling</Code>, <Code>--cpu</Code>,{" "}
          <Code>--categories</Code>, <Code>--concurrency</Code>, <Code>--accuracy</Code>. Run{" "}
          <Code>npm run ci -- --help</Code> for the full list.
        </P>

        <H3>Setting the bars</H3>
        <P>
          <Code>--budget 90</Code> sets one bar for every category. A config file sets them per
          category, and the two are designed to be used together:
        </P>
        <Terminal caption="lighthouse-budgets.json">
          {`{
  "budgets": {
    "performance": 90,
    "accessibility": 100,
    "seo": 90
  }
}`}
        </Terminal>
        <Callout tone="note" label="Precedence runs the opposite way to most tools">
          The flag is the <em>floor</em> and the file is the exception list, so{" "}
          <Code>--budget 90</Code> plus a file saying <Code>performance: 70</Code> reads as “90
          everywhere, except performance only needs 70”. The usual convention — the flag beats the
          file — would make the pair useless, because the blanket number would flatten every line
          you wrote.
        </Callout>
        <List>
          <LI>
            A category with no bar is reported and never fails the build, so a future sixth
            Lighthouse category cannot retroactively break your pipeline.
          </LI>
          <LI>
            A page that could <strong className="font-medium text-foreground">not</strong> be
            audited fails. CI does not go green on the unknown.
          </LI>
          <LI>
            Budget only what you measure. A bar on a category <Code>--categories</Code> did not run
            has no score to clear, and the command says so before it spends a minute in Chrome. A
            misspelled category name is an error naming the valid ones, not a silent shrug.
          </LI>
        </List>

        <H3>Reporters and exit codes</H3>
        <P>
          <Code>--reporter json|jsonExpanded|csv|html</Code> writes the report to the terminal, or
          to <Code>--output &lt;path&gt;</Code>. <Code>json</Code> is the format of record,{" "}
          <Code>csv</Code> opens in a spreadsheet, and <Code>html</Code> is a self-contained page to
          keep as a build artifact. The verdict and the failing lines always go to the error stream,
          so they survive whichever reporter you pick.
        </P>
        <SpecList
          rows={[
            { term: "Exit 0", detail: "Every budget met." },
            {
              term: "Exit 1",
              detail: "A budget violation, or a page that failed to audit.",
            },
            {
              term: "Exit 2",
              detail:
                "A usage error — bad flags, an unreadable config, no targets. Separated on purpose, so a typo in a pipeline never reads as a site regression.",
            },
          ]}
        />

        <H3>CI runs are ordinary runs</H3>
        <P>
          Every audit the command does is saved to the same archive as everything else. A failed
          build opens in <DocLink href="/history">History</DocLink> beside the runs you did by
          hand, has a <DocLink href="#trace">Trace</DocLink> tab, and can be compared against last
          week in <DocLink href="#compare">Compare</DocLink>. That shared archive is the reason to
          run the audit here rather than in a throwaway container.
        </P>

        <H3>In GitHub Actions</H3>
        <Terminal caption=".github/workflows/lighthouse.yml">
          {`- uses: actions/checkout@v4
  with:
    repository: mysleekdesigns/light-audit-score-app

- uses: actions/setup-node@v4
  with:
    node-version: 24

- run: npm ci

- name: Audit against budgets
  run: |
    npm run ci -- \\
      https://example.com \\
      https://example.com/pricing \\
      --budget 90 \\
      --reporter html \\
      --output lighthouse-ci.html

- name: Upload the report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: lighthouse-ci
    path: lighthouse-ci.html`}
        </Terminal>
        <Callout tone="warn" label="Two traps in that workflow">
          <Code>npm ci</Code> installs dependencies and <Code>npm run ci</Code> runs the audit —
          unrelated commands that happen to share three letters. And history lives in{" "}
          <Code>data/</Code> inside the checkout, which a runner throws away at the end of the job:
          point <Code>LH_DATA_DIR</Code> at a cached or mounted directory if you want the archive
          to build up across builds.
        </Callout>
      </DocsSection>

      <DocsSection
        id="mcp"
        index={docsPlate("mcp")}
        title="Your coding agent"
        lede="LightAudit Score as an MCP server: the agent you already code with audits the page you just changed, and answers “did that make it worse?” from your own history."
      >
        <P>
          Other Lighthouse tools for agents are single-page wrappers — they audit, they answer,
          they forget. This one is backed by the archive on your disk, so a baseline you audited by
          hand on Monday is a legitimate comparison for a run the agent does on Friday. Its audits
          land in the same History, and show up in the app beside your own.
        </P>

        <H3>Connect it</H3>
        <Terminal caption="terminal">
          {`claude mcp add lightaudit -- node \\
  --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \\
  --import ./scripts/alias-hooks.mjs ./scripts/mcp-server.ts`}
        </Terminal>
        <P>
          It needs exactly what the rest of the app needs — Node.js 24 or newer and Chrome — and
          nothing else: no server running, no session token, no port, no API key. The same thing
          can be declared under <Code>mcpServers</Code> in a machine-local{" "}
          <Code>.mcp.json</Code>.
        </P>
        <Callout tone="warn" label="Those relative paths are relative to the agent">
          They resolve against the agent’s own working directory, not this project’s, so they only
          hold when the agent starts inside the checkout. Anywhere else, write both paths out in
          full.
        </Callout>

        <H3>The four tools</H3>
        <SpecList
          rows={[
            {
              term: "audit_url",
              value: "~15–60s",
              detail:
                "Runs a real Lighthouse audit and returns the category scores and Core Web Vitals, with the id it was archived under. It defaults to a single run rather than the app’s median of three, because an agent sits blocked for the whole audit with no progress to watch — ask it for three runs when you want a number directly comparable to the app’s.",
            },
            {
              term: "get_history",
              value: "free",
              detail:
                "Recent runs for a page, or across every page. This is the tool that finds a baseline.",
            },
            {
              term: "compare_runs",
              value: "reads two reports",
              detail: (
                <>
                  The <DocLink href="#compare">What Changed</DocLink> diff between two run ids —
                  which checks moved, and what that did to the score. It returns a bounded summary
                  rather than the report, because an agent pays for every token.
                </>
              ),
            },
            {
              term: "check_budget",
              value: "free",
              detail: (
                <>
                  Asserts an already-stored run against a bar, with the same inverted precedence as{" "}
                  <DocLink href="#ci">Budgets in CI</DocLink>. A budget that fails is a normal
                  answer, not an error.
                </>
              ),
            },
          ]}
        />

        <H3>What the loop looks like</H3>
        <P>You describe the intent; the agent picks the tools.</P>
        <Terminal caption="the things you actually type">
          {`Audit http://localhost:3000/pricing and give me the scores.

  … you make the change …

Audit it again, then compare the two runs.

How has that page trended this week?

Can we ship it? 90 everywhere, performance only needs 80.`}
        </Terminal>

        <H3>Worth knowing before you connect it</H3>
        <List>
          <LI>
            <strong className="font-medium text-foreground">
              An agent you connect can read your whole archive.
            </strong>{" "}
            Asking for history with no address returns your most recent runs whatever they were —
            every page you have audited, staging and internal hosts included. That is what makes
            “compare this against my baselines” work, and it is worth knowing before connecting a
            model that also reads the web.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">The model picks the target.</strong>{" "}
            It is the difference between this and the command line, where you type the address.
            There is no host allow-list, so a local development server and private network
            addresses are in range.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">
              Your <Code>.env</Code> site credentials do not apply here.
            </strong>{" "}
            The values from <DocLink href="#authentication">Behind a login</DocLink> are not read by
            this server. Deliberately: the model chooses the target, and an ambient credential it
            could aim at your staging host is one it could aim there on its own initiative.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">It is not read-only.</strong> Its
            audits write rows to your database, which is the point — that is how they show up in
            the UI beside yours.
          </LI>
        </List>
        <Callout tone="note" label="No port and no token, on purpose">
          The server is a local program talking down a pipe to whoever launched it. It opens no
          port, so there is nothing on your machine to reach; it needs no session token, because
          there is no HTTP server here to protect. The audit itself forks the same worker as
          everything else, and that worker is handed a filtered environment — your agent’s own API
          keys never travel into the browser rendering the page under audit.
        </Callout>
        <Callout tone="warn" label="Which folder it starts in decides which archive it writes to">
          The server anchors itself to the project folder and reads <Code>LH_DATA_DIR</Code> from{" "}
          <Code>.env</Code> so that the agent and the app share one history. If you set that
          variable, make sure both see the same value — otherwise you get two archives and every
          comparison silently looks at the wrong one.
        </Callout>
        <P>
          <Code>npm run mcp</Code> starts it by hand, which is useful only for checking that it
          starts and reading its messages. Normally the agent launches it; on your terminal it just
          sits waiting.
        </P>
      </DocsSection>
    </>
  );
}
