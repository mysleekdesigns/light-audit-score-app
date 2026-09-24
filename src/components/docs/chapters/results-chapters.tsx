/**
 * Manual chapters 14–18: working with results you already have — the archive,
 * what a single run recorded while it loaded, trends and audit-level diffs,
 * batch summaries and the client report, and daily schedules with their
 * regression alerts.
 *
 * "Trace & filmstrip" is the one chapter here that is not a page: it is a tab
 * inside a run, and it sits second because that is the reading order — find the
 * run in History, then look inside it, then compare it with another.
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

export function ResultsChapters() {
  return (
    <>
      <DocsSection
        id="history"
        index={docsPlate("history")}
        title="History"
        lede="Every audit you have run, grouped by website, showing each page’s latest result and whether it moved since last time."
      >
        <P>
          Nothing here needs saving — completed audits arrive automatically. A page you have audited
          twenty times appears as a single row showing the most recent result, not twenty rows. Rows
          are gathered into collapsible sections, one per website, with the most recently audited
          site open and the rest folded away.
        </P>

        <H3>Finding things</H3>
        <SpecList
          rows={[
            {
              term: "Filter by URL",
              detail:
                "Type any part of an address to narrow the list as you go. No need to press anything.",
            },
            {
              term: "Needs work",
              detail:
                "One click hides every page that scored 90 or above in every category, leaving only the pages with something to fix. The button carries a count.",
            },
            {
              term: "Sorting",
              detail:
                "Click any column heading. The default order puts a site’s home page first, then its other pages, with blog posts last — the order you would actually review a site in.",
            },
            {
              term: "Table or Cards",
              detail:
                "Table is dense and sortable. Cards show score rings and speed metrics for each page. The choice is shared with the live results panel.",
            },
          ]}
        />
        <P>
          The whole page is filtered and sorted in your browser, so it is instant, and there is no
          pagination to click through.
        </P>

        <H3>What a row tells you</H3>
        <List>
          <LI>
            Every category score, each with a small arrow when it moved since the previous audit
            of the same page. Hovering the arrow shows the exact before and after.
          </LI>
          <LI>
            A badge for the device, and one for the engine — <Code>LHA</Code> for a local audit,{" "}
            <Code>PSI</Code> for a Google-hosted one.
          </LI>
          <LI>
            When both mobile and desktop audits exist, the table grows a second set of columns so
            you can read the two side by side. On a narrower window a toggle picks which device to
            show.
          </LI>
          <LI>Failed audits show a red badge and the error message instead of scores.</LI>
        </List>

        <H3>Row actions</H3>
        <List>
          <LI>
            <strong className="font-medium text-foreground">Re-run</strong> repeats that one page
            with exactly the settings it used before. You stay on the History page and the row
            updates in place when it finishes.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Open HTML report</strong> opens
            Google’s full report for that audit in a new tab.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Raw JSON</strong> opens the underlying
            data, for feeding into something else.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Export</strong> downloads that one
            audit on its own as <UiLabel>JSON</UiLabel> or <UiLabel>CSV</UiLabel> — the same flat
            record the bulk export below produces, without the rest of the archive. The file is
            named after the page and device, so a folder of them stays readable.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Delete</strong> removes that audit and
            its stored reports, after a confirmation.
          </LI>
        </List>

        <H3>Bulk actions</H3>
        <P>
          The strip at the bottom of the control panel counts what is currently in view and acts on
          it: <UiLabel>JSON</UiLabel> and <UiLabel>CSV</UiLabel> download every visible row in one
          file, and <UiLabel>Open all</UiLabel> opens every visible report in its own tab.
        </P>
        <P>
          Each website header has an Export of its own, too. It downloads every page currently
          shown under that site — the whole crawl — as one <UiLabel>JSON</UiLabel> or{" "}
          <UiLabel>CSV</UiLabel> file, leaving the other sites in view out of it. It respects the
          filter box, so narrow the list first if you only want part of a site.
        </P>
        <Callout tone="warn" label="Clear history is permanent">
          <UiLabel>Clear history</UiLabel> deletes every stored audit and report, not just the ones
          you have filtered to, and it cannot be undone. Your saved schedules survive it.
        </Callout>
        <Callout tone="note">
          If <UiLabel>Open all</UiLabel> only opens a few tabs, your browser’s pop-up blocker
          stopped the rest. The app tells you how many made it through.
        </Callout>
      </DocsSection>

      <DocsSection
        id="trace"
        index={docsPlate("trace")}
        title="Trace & filmstrip"
        lede="Every file the page fetched, and what the screen actually looked like while it loaded. Both were always in the report; this is where you can finally see them."
      >
        <P>
          Open any finished result — <UiLabel>View →</UiLabel> in the live panel or in History —
          and pick the <UiLabel>Trace</UiLabel> tab, beside <UiLabel>Report</UiLabel> and{" "}
          <UiLabel>Analysis</UiLabel>. Nothing extra was measured to produce it: every audit has
          always recorded this, and Google’s own report never shows it.
        </P>

        <H3>The filmstrip</H3>
        <P>
          Screenshots taken through the load, laid out against a time axis with each frame’s
          capture time underneath. The frame where the largest element finished painting carries an{" "}
          <Code>LCP</Code> badge, and the heading repeats that time as a number — so “the LCP
          happened at 2.4 s” never depends on spotting a mark. Click any frame to enlarge it,
          because a thumbnail tells you something was painting but not what a visitor could
          actually read at 1.2 seconds.
        </P>

        <H3>The waterfall</H3>
        <P>
          Four figures across the top — <UiLabel>Requests</UiLabel>,{" "}
          <UiLabel>Transferred</UiLabel>, <UiLabel>Third-party</UiLabel> and{" "}
          <UiLabel>Timeline</UiLabel> — then one row per request.
        </P>
        <List>
          <LI>
            Columns for the request, its type, its size, a bar showing when it started and how long
            it took, and that duration as a figure. Click any heading to sort; the order Lighthouse
            recorded is always recoverable.
          </LI>
          <LI>
            Two marks worth hunting for. <Code>RB</Code> means render-blocking — the page could not
            paint until that file arrived. <Code>3P</Code> means third-party, something served by
            somebody other than the site itself. Both are words, not just bar colours.
          </LI>
          <LI>
            The total transferred here is the same number Lighthouse reports as the page weight, so
            it can be checked against the full report rather than taken on trust.
          </LI>
        </List>
        <Callout tone="note" label="The rows are deliberately not links">
          A page under audit chooses its own subresource addresses, and a hostile one would be
          choosing what a hundred clickable links in your browser point at. The full address is on
          hover instead.
        </Callout>

        <H3>It is read only when you ask for it</H3>
        <P>
          A stored report is often 0.7–1.5 MB, so nothing is read until you open the tab — History
          stays exactly as fast as it was — and your browser is only ever sent the small extract,
          never the report itself. Once read it is remembered for that run, so switching to
          Analysis and back costs nothing.
        </P>
        <Callout tone="warn" label="Older runs have no trace">
          A run audited before this feature existed shows an empty state saying so rather than an
          error; the data was never stored and cannot be reconstructed. Re-run the page to capture
          it. A run that did not include the Performance category has no filmstrip either — that is
          the audit the frames come from.
        </Callout>
      </DocsSection>

      <DocsSection
        id="compare"
        index={docsPlate("compare")}
        title="Compare & trends"
        lede="Whether a page is getting better over time, and exactly what changed between any two audits of it."
      >
        <P>
          <DocLink href="/compare">Compare</DocLink> works on one page at a time. Pick the address
          from the dropdown at the top — it starts on whichever page you have audited most — and the
          rest of the screen fills in.
        </P>

        <H3>The trend chart</H3>
        <P>
          Every category score plotted across every audit of that page, oldest to newest. The scale
          is fixed at 0–100 so the shape never lies, the 90-and-above region is tinted green, and 90
          itself is marked with a dashed line. Underneath, a small sparkline per category gives each
          one its own shape at a glance with the latest value beside it. Two audits are the minimum
          for a trend; with one, the app says so.
        </P>

        <H3>The diff</H3>
        <P>
          Two dropdowns, <UiLabel>Baseline</UiLabel> and <UiLabel>Comparison</UiLabel>, choose which
          two audits to put side by side. They start on the oldest and the newest. The result is two
          tables:
        </P>
        <List>
          <LI>
            <strong className="font-medium text-foreground">Category scores</strong>, where higher
            is better — an improvement shows a green arrow pointing up.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Core Web Vitals</strong>, where lower is
            better — an improvement shows a green arrow pointing{" "}
            <em>down</em>. The colour, not the direction, is what tells you whether it is good news.
            The table is labelled to remind you.
          </LI>
        </List>
        <P>
          A summary underneath counts how many measurements improved, regressed and stayed the same,
          along with how much time separated the two audits. Buttons open each side’s full report.
        </P>
        <Callout tone="note">
          Every arrow also carries an invisible word — improved, regressed, no change — so the
          meaning survives for screen readers and anyone who cannot distinguish the colours.
        </Callout>
        <Callout tone="warn">
          If a page has both local and PageSpeed audits, Compare warns you before you diff one
          against the other. They were measured on different hardware, so the difference is not only
          the page.
        </Callout>

        <H3>What Changed — why the score moved</H3>
        <P>
          The two tables above tell you Performance fell eight points. The third card tells you
          which eight points. It uses the same <UiLabel>Baseline</UiLabel> and{" "}
          <UiLabel>Comparison</UiLabel> pickers, and it waits to be asked — press{" "}
          <UiLabel>Show what changed</UiLabel>, because answering means reading both stored reports
          in full, where everything above was already on the page.
        </P>
        <P>
          Four figures lead: how many individual checks moved, how the opportunities changed, and
          how the request count and total transfer differ. Then four tabs.
        </P>
        <SpecList
          rows={[
            {
              term: "Audits",
              detail:
                "Every individual Lighthouse check that moved, tallied as regressed, improved, and present-on-one-side-only. The ones that did not move — usually around 150 of them — are counted and not listed, which is what makes the short list believable.",
            },
            {
              term: "Opportunities",
              detail:
                "Ranked by how much the estimated saving changed, biggest regression first. An opportunity that appeared on only one of the two runs is still shown, which is normally the whole point.",
            },
            {
              term: "Requests",
              detail:
                "What the page fetched that it did not before, what it stopped fetching, and what grew. Totals lead the tab, then the rows whose size actually changed.",
            },
            {
              term: "Explain",
              detail: (
                <>
                  Hands that diff to your AI so it explains <em>this change</em> rather than
                  re-diagnosing the page from scratch. See{" "}
                  <DocLink href="#ai-analysis">Ask why a score is low</DocLink>.
                </>
              ),
            },
          ]}
        />
        <Callout tone="note" label="Expect churn in the request list">
          Analytics and advertising beacons put a fresh session id in their address on every load,
          so two runs of an unchanged page can show a dozen requests “added” and a dozen “removed”
          that are really the same requests. The totals at the top do not move with that, and the
          rows whose size changed sort first — read those.
        </Callout>
        <Callout tone="tip" label="The shortcut from a re-run">
          On <DocLink href="/batches">Batches</DocLink>, a card that repeated an earlier batch
          carries a <Code>↻ re-run of …</Code> chip with a <UiLabel>what changed</UiLabel> link
          beside it. It lands here with the right pair already chosen — matched on the same page and
          the same device, and pointing at whichever page lost the most points — and the card
          already open.
        </Callout>
        <Callout tone="note">
          An explanation is generated fresh each time and is not saved. It never replaces the run’s
          own stored analysis, so asking “why did this drop?” here cannot overwrite “why is this
          score low?” there.
        </Callout>
      </DocsSection>

      <DocsSection
        id="batches"
        index={docsPlate("batches")}
        title="Batches & thresholds"
        lede="Each group of pages you audited together, averaged, with the best and worst page and a pass mark you set yourself."
      >
        <P>
          A batch is one press of the run button: the whole set of pages you queued at once, or one
          firing of a schedule. <DocLink href="/batches">Batches</DocLink> shows them newest first,
          one card each. Where History answers “how is this page doing?”, Batches answers “how did
          that whole run go?”.
        </P>

        <H3>Set your own pass mark</H3>
        <P>
          The panel at the top holds a number box per category, all starting at 90. Change them to
          whatever your project actually requires. Every card on the page re-marks itself
          immediately, and the readout tells you how many pages and how many batches clear the bar
          across your entire archive.
        </P>
        <Callout tone="note">
          These thresholds are shared with the Lighthouse page’s defaults and remembered in your
          browser. <UiLabel>Reset to 90</UiLabel> puts them back.
        </Callout>

        <H3>What a card shows</H3>
        <List>
          <LI>
            <strong className="font-medium text-foreground">Average scores</strong> across the
            batch, one ring per category.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Best and worst page</strong>, each
            linking straight to its report.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Pass and fail counts</strong> per
            category against your thresholds, green when everything clears.
          </LI>
          <LI>
            Status, how many pages succeeded or failed, the settings used, and a drift warning if
            the machine’s power varied enough to make Performance untrustworthy.
          </LI>
          <LI>
            A <Code>re-run of …</Code> badge when this batch repeated an earlier one, so you can
            trace a before and after.
          </LI>
        </List>

        <H3>Actions</H3>
        <P>
          <UiLabel>Re-run</UiLabel> repeats the batch with identical settings and takes you to the
          live console to watch. <UiLabel>Open all</UiLabel> opens every report in the batch.{" "}
          <UiLabel>JSON</UiLabel> and <UiLabel>CSV</UiLabel> download the batch’s data, failures
          included.
        </P>

        <H3>The client report</H3>
        <P>
          <UiLabel>Report</UiLabel> builds something different from the other two: a single{" "}
          <Code>.html</Code> file you can hand to somebody who will never open this app. It carries
          the batch summary, every page’s scores and Core Web Vitals, the top opportunities, and
          each page’s request waterfall and loading filmstrip.
        </P>
        <P>
          The file is <strong className="font-medium text-foreground">self-contained</strong>. Every
          image is embedded in it and it loads no stylesheet, font, or script from anywhere, so it
          renders the same on a machine with no internet connection as it does on yours — and it
          cannot report back to anyone that it was opened. Because it reads each page’s stored
          report to draw the waterfalls, it takes a moment longer to build than the JSON or CSV.
        </P>
        <P>
          Print it from the browser (<Code>⌘P</Code>) and it switches to a light, ink-sane layout
          made for paper rather than the dark console you see on screen. Choose{" "}
          <UiLabel>Save as PDF</UiLabel> and you have a client-ready document with no extra tool
          involved. To put your own name on it, fill in <UiLabel>Report header</UiLabel> on the
          Settings page — a title, a strapline, a logo and whether to print the date.
        </P>

        <H3>Check it before you send it</H3>
        <P>
          The report is a faithful record of what the audit saw, which is exactly why it is worth
          a glance before it leaves your machine. It contains{" "}
          <strong className="font-medium text-foreground">
            the full request URLs each page loaded
          </strong>{" "}
          &mdash; query strings included &mdash; and{" "}
          <strong className="font-medium text-foreground">real screenshots of the pages</strong>{" "}
          as they loaded, large enough to read a heading or a signed-in user&rsquo;s name.
        </P>
        <P>
          Values that look like a credential, a signature or a session &mdash; <Code>token</Code>,{" "}
          <Code>sig</Code>, <Code>X-Amz-Signature</Code>, <Code>sid</Code> and their relatives
          &mdash; are replaced with <Code>[redacted]</Code>, and a{" "}
          <Code>user:password@</Code> prefix is removed. The parameter name is left in place on
          purpose, so you can see that something was there rather than being told a URL was clean.
          That is a safety net, not a promise: parameter names vary endlessly and no list catches
          them all.
        </P>
        <P>
          So if you audited a staging site, anything behind a login, or a page you reached through
          a one-time link, read the waterfall and the filmstrip before forwarding the file. Nothing
          from the <UiLabel>Authentication</UiLabel> panel is ever written into it &mdash; your
          passwords, cookies and headers stay out of every export &mdash; but the session those
          credentials opened is what the audit photographed.
        </P>
      </DocsSection>

      <DocsSection
        id="schedule"
        index={docsPlate("schedule")}
        title="Scheduled audits"
        lede="Audit the same pages at the same time every day, and build a record without remembering to press anything."
      >
        <H3>Creating one</H3>
        <P>
          Schedules are created from the audit form, not from the Schedule page. Set up the pages
          and settings you want repeated, then press <UiLabel>Save as daily</UiLabel> in the run
          config footer. It is on both the Lighthouse and the PageSpeed page, so a schedule can use
          either engine. A PageSpeed schedule needs the machine to be online when it fires, because
          PageSpeed only works online.
        </P>
        <Steps>
          <Step title="Name it">
            Optional. Left blank, it names itself after the first address.
          </Step>
          <Step title="Choose a time">
            An <Code>HH:MM</Code> picker, defaulting to 09:00, in your server’s local time. Daily is
            the only cadence — there is no weekly option and no cron expression.
          </Step>
          <Step title="Check the target preview">
            The dialog summarises what will run: the addresses or the crawl settings, the engine,
            device, repeats and concurrency.
          </Step>
        </Steps>
        <Callout tone="note" label="A crawl schedule re-discovers each time">
          If you save a crawl rather than a fixed list, each daily run crawls the site again. New
          pages get picked up automatically, which is usually what you want from a monitor.
        </Callout>

        <H3>What each card shows</H3>
        <SpecList
          rows={[
            { term: "Cadence", detail: "The time it fires each day." },
            {
              term: "Next run",
              detail: "The next firing, with a live countdown that ticks every minute.",
            },
            { term: "Last run", detail: "When it last fired, and which batch that produced." },
            {
              term: "Total runs",
              detail: "How many times it has fired, flagged in amber if the last one had errors.",
            },
          ]}
        />

        <H3>Run now and Pause</H3>
        <P>
          One button changes role depending on what is happening.{" "}
          <UiLabel>Run now</UiLabel> fires the schedule immediately without waiting for its time.
          While a run is in flight, the same button becomes <UiLabel>Pause</UiLabel>.
        </P>
        <Callout tone="warn" label="Pause stops the run, not the schedule">
          Pausing stops the audit currently in progress and keeps the pages that already finished.
          Pressing <UiLabel>Run now</UiLabel> afterwards picks up from where it stopped rather than
          starting over. The daily cadence keeps firing either way — to stop a schedule recurring,
          delete it.
        </Callout>

        <H3>Regression alerts</H3>
        <P>
          A schedule that runs every night is only half a monitor. The other half is being told
          when something moved. Each schedule can compare every firing with the one before it and
          report what crossed — on its own card, and optionally into a chat channel.
        </P>
        <P>
          Alerts are armed per schedule, not globally: press the pencil ({" "}
          <UiLabel>Edit schedule</UiLabel> ) on a card and switch{" "}
          <UiLabel>Alerts</UiLabel> on. They are off by default, so updating the app never starts
          anything talking on a schedule nobody armed.
        </P>
        <SpecList
          rows={[
            {
              term: "Watched categories",
              value: "all five",
              detail: "Which of the five scores this schedule pays attention to.",
            },
            {
              term: "Minimum drop",
              value: "5 points",
              detail:
                "A fall of this many points is reported even when it crosses no bar. Lighthouse drifts a couple of points between identical runs, so a lower number is a noisier one.",
            },
            {
              term: "Pass bars",
              value: "copied on arming",
              detail: (
                <>
                  The thresholds a crossing is measured against. They are copied from your{" "}
                  <DocLink href="#batches">Batches</DocLink> thresholds the moment you arm alerts,
                  and the schedule owns its copy from then on — a scheduler firing at 03:00 has no
                  browser to read your settings from, and dragging a dial to eyeball one batch must
                  not silently re-arm a monitor you configured months ago. The dialog prints the
                  bars it is using.
                </>
              ),
            },
          ]}
        />

        <H3>What it reports</H3>
        <List>
          <LI>
            <strong className="font-medium text-foreground">Crossed below</strong> — a score fell
            through its pass bar. The event names the bar it crossed.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Recovered</strong> — it climbed back
            over a bar it was under. Recoveries are reported as loudly as regressions, which is the
            point: you want to know the fix landed.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Dropped</strong> — a slide of at least
            your minimum that crossed nothing. It prints no bar, because there was none.
          </LI>
        </List>
        <P>
          Mobile and desktop are compared separately, a page is only ever compared with itself, and
          each score produces at most one event — a crossing is never also reported as a slide.
          Nothing crossing means nothing is said.
        </P>
        <Callout tone="note" label="Silence is not always agreement">
          The very first firing of a new schedule never alerts: there is nothing to compare it
          against, and the card says so rather than claiming all is well. A category that failed to
          score is also silence rather than a zero — otherwise one flaky night would report every
          category of every page as collapsed.
        </Callout>

        <H3>Where alerts appear</H3>
        <P>
          On the schedule’s own card, always. The telemetry row shows{" "}
          <Code>Alerts · Armed · 5/5 categories · ≥5pt</Code> or <Code>Disarmed</Code>, and an{" "}
          <UiLabel>Alerts</UiLabel> strip underneath lists recent events — the before and after
          scores, the change, the bar, the category, the device and the page. Each row is tagged{" "}
          <Code>sent</Code> or <Code>in-app</Code> depending on whether a webhook took it.
        </P>
        <P>
          To be told without opening the app, add a Slack or Discord incoming webhook to{" "}
          <Code>.env</Code> and restart. The body is Slack-compatible; a Discord webhook works if
          you append <Code>/slack</Code> to it.
        </P>
        <Terminal caption=".env">
          {`LH_ALERT_WEBHOOK_URL=https://your-chat-host.example/webhook/id`}
        </Terminal>
        <Callout tone="note">
          Anyone holding that address can post into your channel, so it is treated as a credential:
          it lives in <Code>.env</Code> only, never in a schedule, and Settings reports nothing
          beyond whether one is present. A delivery that fails is logged without the address and
          never fails the audit — the event is still recorded on the card, tagged{" "}
          <Code>in-app</Code>.
        </Callout>

        <H3>Run history</H3>
        <P>
          Each card lists its most recent firings, newest first, with a status and a page count.
          Click a row to open the live console for that batch. The bin icon at the end of a row
          deletes that run and its reports, after a confirmation; it is disabled for a run still in
          progress, which you must pause first.
        </P>
        <P>
          Deleting the schedule itself removes only the recurring entry. Every audit it has already
          produced stays in History and Batches.
        </P>

        <Callout tone="warn" label="The app has to be running">
          Schedules fire from inside the app, which checks once a minute. Nothing happens while the
          terminal is closed. If a scheduled time passes while the app is off, that run fires as
          soon as you start it again, so long as the same day’s window has not already been
          satisfied.
        </Callout>
      </DocsSection>
    </>
  );
}
