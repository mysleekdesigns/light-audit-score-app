/**
 * Manual chapters 12–15: the four pages that work with results you already have
 * — the archive, trends and diffs, batch summaries, and daily schedules.
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
                "One click hides every page that scored 90 or above in all four categories, leaving only the pages with something to fix. The button carries a count.",
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
            The four scores, each with a small arrow when it moved since the previous audit of the
            same page. Hovering the arrow shows the exact before and after.
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
            <strong className="font-medium text-foreground">Delete</strong> removes that audit and
            its stored reports, after a confirmation.
          </LI>
        </List>

        <H3>Bulk actions</H3>
        <P>
          The strip at the bottom of the control panel counts what is currently in view and acts on
          it: <UiLabel>JSON</UiLabel> and <UiLabel>CSV</UiLabel> download the visible rows, and{" "}
          <UiLabel>Open all</UiLabel> opens every visible report in its own tab.
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
          All four scores plotted across every audit of that page, oldest to newest. The scale is
          fixed at 0–100 so the shape never lies, the 90-and-above region is tinted green, and 90
          itself is marked with a dashed line. Underneath, four small sparklines give each category
          its own shape at a glance with the latest value beside it. Two audits are the minimum for
          a trend; with one, the app says so.
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
          The panel at the top holds four number boxes, one per category, all starting at 90. Change
          them to whatever your project actually requires. Every card on the page re-marks itself
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
            batch, as four rings.
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
          either engine.
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
