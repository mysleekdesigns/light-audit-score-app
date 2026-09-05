/**
 * Manual chapters 05–09: the run-config dials, how to get numbers you can
 * trust, finding pages to audit, the Google-hosted PageSpeed engine, and the
 * fifth category — which lands here, after both engines, because it is scored
 * on both and its caveats belong beside "Trustworthy numbers".
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

export function AuditingChapters() {
  return (
    <>
      <DocsSection
        id="audit-settings"
        index={docsPlate("audit-settings")}
        title="Audit settings"
        lede="Every dial in Run config, what it changes, and when the default is the right answer."
      >
        <P>
          The <UiLabel>Run config</UiLabel> half of the audit form holds six dials, five category
          switches and two flags. Your choices are remembered for next time, so you normally set
          them once. Everything is locked while an audit is running.
        </P>

        <SpecList
          rows={[
            {
              term: "Device",
              value: "Mobile",
              detail:
                "Mobile, Desktop, or Both. Mobile is the default because it is the harder test and the one Google grades sites on. Both audits each page twice, so it doubles the time.",
            },
            {
              term: "Throttling",
              value: "Simulated",
              detail:
                "Simulated loads the page once at full speed and calculates what a slow phone would have experienced. Applied genuinely slows the browser down. Simulated is faster, steadier, and matches what Chrome’s own tool and Google report — leave it unless you specifically want measured-under-load behaviour.",
            },
            {
              term: "CPU slowdown",
              value: "Auto (4×)",
              detail: (
                <>
                  How much the processor is held back to imitate a phone. Leave on Auto and use{" "}
                  <UiLabel>Calibrate</UiLabel> instead of picking a number by hand — the next
                  chapter explains why.
                </>
              ),
            },
            {
              term: "Runs per URL",
              value: "3",
              detail:
                "How many times each page is audited before the middle result is kept. One is fast and noisy, five is slow and steady. Three is the sensible middle.",
            },
            {
              term: "Concurrency",
              value: "3",
              detail:
                "How many pages are audited at the same time. Higher finishes a long list sooner but makes Performance scores read lower than they should, because the audits compete for your processor. Accessibility, Best Practices and SEO are unaffected, and Agentic Browsing very nearly so — layout stability is its only check that comes from the timed part of the audit.",
            },
            {
              term: "User agent",
              value: "Default",
              detail:
                "Leave as-is unless a site blocks the audit or serves it a different page. Choosing Desktop Chrome or Mobile Chrome makes the audit look like an ordinary visitor, which helps with bot protection.",
            },
            {
              term: "Categories",
              value: "all five",
              detail:
                "Turn off what you do not need to make audits quicker. At least one must stay on — the app quietly refuses to let you clear the last.",
            },
            {
              term: "Accuracy mode",
              value: "Off",
              detail:
                "Runs one page at a time and discards outlier runs. The steadiest numbers this machine can produce, at the cost of speed.",
            },
            {
              term: "Clear storage",
              value: "Off",
              detail:
                "On empties the browser cache between runs, so every run is a first-time visitor. Off keeps a warm cache, like a returning visitor. Chrome’s own panel clears storage, and the Match DevTools button turns this on for you.",
            },
          ]}
        />

        <Callout tone="note" label="Two dials, one idea">
          Accuracy mode and Concurrency control the same thing from opposite ends, so the app keeps
          them consistent. Turning accuracy mode on drops concurrency to 1. Raising concurrency
          above 1 turns accuracy mode off. Either way it tells you what it did.
        </Callout>

        <Callout tone="warn" label="“Both” doubles the work">
          Choosing <UiLabel>Both</UiLabel> for the device turns a list of 50 pages into 100 audits.
          Worth knowing before you set a big crawl running.
        </Callout>
      </DocsSection>

      <DocsSection
        id="accuracy"
        index={docsPlate("accuracy")}
        title="Trustworthy numbers"
        lede="Performance scores depend on the machine that measured them. Two buttons on the audit form deal with that; this chapter explains which to press."
      >
        <P>
          Accessibility, Best Practices and SEO are stable — they check facts about the page, and
          they give the same answer every time. Agentic Browsing is nearly as stable: only its
          layout-stability check comes from the timed part of the audit. Performance is different. It is a measurement of
          speed, so it inherits the conditions of the machine doing the measuring. Everything in
          this chapter is about Performance.
        </P>

        <H3>Why your fast laptop gives an optimistic score</H3>
        <P>
          Lighthouse imitates a mid-range phone by slowing your processor down four times. That
          multiplier is not an absolute setting — it is relative to the machine you are on. Four
          times slower than a high-end desktop of a few years ago genuinely is a mid-range phone.
          Four times slower than a modern Apple Silicon Mac is still much faster than any phone, so
          the page looks better than it really is.
        </P>
        <P>
          Every audit records how powerful your machine was at that moment, and it is shown on the
          environment badge. A modern Mac reads around 4000; a high-end desktop, around 1750.
        </P>

        <H3>Calibrate — the button to press once</H3>
        <P>
          <UiLabel>Calibrate</UiLabel> reads that number from your most recent audit and works out
          the slowdown multiplier that actually reproduces a mid-range phone{" "}
          <em>on your hardware</em>. It saves the result as your default, so you press it once and
          then forget it. It is greyed out until you have run at least one audit, because it has
          nothing to read until then.
        </P>

        <H3>Match DevTools — the button for settling arguments</H3>
        <P>
          <UiLabel>Match DevTools</UiLabel> sets everything to exactly what Chrome’s built-in
          Lighthouse panel uses: mobile, simulated throttling, a single run, one page at a time,
          accuracy mode on, a cleared cache, and the standard 4× multiplier in place of any
          calibrated value. Use it when your number disagrees with someone else’s and you want to
          compare like with like. It saves those as your defaults, so switch back afterwards.
        </P>
        <Callout tone="note">
          The two buttons pull in opposite directions on purpose. Calibrate gives the most
          <em> representative </em> number for a real phone. Match DevTools gives the most{" "}
          <em>comparable</em> number. Neither is more correct than the other.
        </Callout>

        <H3>Comparing against Chrome’s own panel</H3>
        <P>
          Best Practices in particular often reads lower in Chrome’s panel than here. Your normal
          Chrome window runs your extensions, and extensions inject console errors and deprecated
          API calls that Lighthouse blames on the page. This app always uses a clean browser with no
          extensions. To compare fairly, run Chrome’s panel in an incognito window.
        </P>

        <H3>The drift warning</H3>
        <P>
          When the app suspects a Performance score reflects the machine rather than the page, it
          shows an amber warning on the result and on the batch summary. It fires for three
          reasons:
        </P>
        <List>
          <LI>
            <strong className="font-medium text-foreground">Host power drift</strong> — the
            slowdown multiplier is a poor fit for this computer. The warning links straight to
            Calibrate.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Processor contention</strong> — your
            machine’s measured power varied a lot across the batch, meaning it was busy or getting
            hot while some pages were audited.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Parallel runs</strong> — the batch ran
            several pages at once, which pushes Performance down. It suggests a re-run in accuracy
            mode.
          </LI>
        </List>
        <P>The warning never appears when Performance was not part of the audit.</P>

        <Callout tone="tip" label="The recipe for a number you can defend">
          Mobile, simulated throttling, calibrated multiplier, accuracy mode on, three or five runs.
          Slower, but as steady as a local measurement gets. For a number to quote to someone
          outside your team, use the <DocLink href="#pagespeed">PageSpeed</DocLink> engine instead —
          your hardware plays no part in it.
        </Callout>
      </DocsSection>

      <DocsSection
        id="discovery"
        index={docsPlate("discovery")}
        title="Finding pages"
        lede="Paste a list you already have, or point the app at a domain and let it find the pages for you."
      >
        <H3>Paste list</H3>
        <P>
          The simplest option. One address per line, or separated by commas. The app tidies the
          list for you: blanks are dropped, duplicates are removed, and the original order is kept.
        </P>
        <List>
          <LI>
            Addresses must be complete, including <Code>https://</Code>. Anything else is counted as
            an ignored line, with its line number shown so you can find it.
          </LI>
          <LI>A batch can hold between one and ten thousand pages.</LI>
        </List>

        <H3>Crawl site</H3>
        <P>
          The second tab. Type a domain and press <UiLabel>Discover</UiLabel> — or just press{" "}
          <Code>Enter</Code> in the field, which does the same thing. The app reads the site’s
          sitemap and follows links from the starting page, staying on the same domain throughout.
          It respects the site’s <Code>robots.txt</Code>, and tells you if crawling was disallowed.
        </P>

        <SpecList
          rows={[
            {
              term: "Domain or seed",
              value: "required",
              detail: (
                <>
                  Where to start. No <Code>https://</Code> needed — it is assumed.
                </>
              ),
            },
            {
              term: "Crawl depth",
              value: "2",
              detail:
                "How many links deep to follow from the starting page. Depth 0 means the starting page only. Depth 2 usually reaches every important page on a normal site.",
            },
            {
              term: "Max pages",
              value: "25",
              detail: "A hard ceiling on how many pages discovery will return. Up to 10,000.",
            },
            {
              term: "Pages / template",
              value: "All pages",
              detail:
                "Samples a few representative pages per URL pattern. On a shop with 2,000 product pages, setting 3 per template gives you three products rather than all of them — enough to spot a problem, without a two-day audit.",
            },
            {
              term: "Discovery sources",
              value: "both on",
              detail:
                "Parse sitemap reads the site’s own index. Crawl links follows links from the page. At least one must stay on. Depth only applies when link crawling is on.",
            },
            {
              term: "Exclude paths",
              value: "optional",
              detail: (
                <>
                  Patterns to skip, one per line or comma separated. Either a prefix like{" "}
                  <Code>/admin</Code> or a wildcard like <Code>/drafts/*</Code>. Up to 50 of them.
                </>
              ),
            },
          ]}
        />

        <H3>Curating what was found</H3>
        <P>
          Discovery never audits anything by itself. It fills a table below the form where you
          decide what actually runs.
        </P>
        <List>
          <LI>Each row has a tick box. Unticked rows are struck through and will not be audited.</LI>
          <LI>
            The table shows which pattern each page matched, whether it came from the sitemap or
            from crawling, and how many links deep it was found.
          </LI>
          <LI>
            <UiLabel>Select all</UiLabel> and <UiLabel>Hide unselected</UiLabel> in the panel header
            make a long list manageable. The <Code>×</Code> at the end of a row removes it
            entirely.
          </LI>
          <LI>The heading keeps a running count, for example <Code>example.com · 12 of 40 selected</Code>.</LI>
        </List>
        <Callout tone="note">
          Changing <UiLabel>Pages / template</UiLabel> re-samples the list from scratch, which
          discards ticks you changed by hand. Set it before you start curating.
        </Callout>
        <P>
          What you typed, which tab you were on, and what you selected are all kept if you navigate
          away and come back.
        </P>
      </DocsSection>

      <DocsSection
        id="pagespeed"
        index={docsPlate("pagespeed")}
        title="PageSpeed Insights"
        lede="The same audit, run on Google’s hardware instead of yours — plus data from real people who visited the page."
      >
        <P>
          The <DocLink href="/pagespeed">PageSpeed</DocLink> page works exactly like the Lighthouse
          page: paste a list or crawl a site, set a few dials, press run, and watch the same results
          grid fill in. Two things are different, and both are the point of using it.
        </P>
        <List>
          <LI>
            <strong className="font-medium text-foreground">Google measures it, not you.</strong>{" "}
            Conditions are fixed and identical for everyone, so your laptop cannot flatter or
            penalise the result. That also means the throttling and processor dials are absent here
            — there is nothing for you to tune.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">You get real-world data.</strong>{" "}
            Google reports what actual Chrome users experienced on that page over the last 28 days,
            which no local audit can tell you.
          </LI>
        </List>

        <H3>You need a free API key</H3>
        <P>
          Google no longer allows anonymous use, so PageSpeed audits fail without a key. Getting one
          is free and takes a couple of minutes.
        </P>
        <Steps>
          <Step title="Enable the API">
            In the Google Cloud console, open the API library and enable{" "}
            <strong className="font-medium text-foreground">PageSpeed Insights API</strong> on a
            project.
          </Step>
          <Step title="Create a key">
            Under APIs &amp; Services → Credentials, create an API key on that same project.
          </Step>
          <Step title="Put it in .env and restart">
            Add <Code>PAGESPEED_API_KEY=your-key-here</Code> to the <Code>.env</Code> file, then
            stop and start the app. Settings will show the key as <UiLabel>Ready</UiLabel>.
          </Step>
        </Steps>
        <P>
          The free tier allows 25,000 requests a day and around 240 a minute. Local Lighthouse
          audits never need this key.
        </P>

        <H3>The dials</H3>
        <SpecList
          rows={[
            {
              term: "Device",
              value: "Mobile",
              detail: "Mobile, Desktop or Both. Both doubles the number of API calls.",
            },
            {
              term: "Report locale",
              value: "Default",
              detail:
                "The language Google writes its recommendations in. Eight languages, plus Google’s own default.",
            },
            {
              term: "Runs per URL",
              value: "3",
              detail: "As with local audits, the middle result is kept. Each run is one API call.",
            },
            {
              term: "Concurrency",
              value: "3",
              detail:
                "How many pages are sent at once. Unlike local audits this does not affect the scores — Google measures each one independently — it only affects the rate limit.",
            },
          ]}
        />

        <Callout tone="note" label="Watch the request counter">
          Each page costs runs × devices in API calls, so 20 pages at 3 runs on both devices is 120
          calls. A live banner does the arithmetic for you and turns amber if the batch would exceed
          Google’s per-minute burst.
        </Callout>

        <H3>Field data — what real visitors experienced</H3>
        <P>
          When a page has enough real traffic, Google includes data from the Chrome User Experience
          Report. Open a PageSpeed result and look for{" "}
          <UiLabel>Field data · CrUX</UiLabel>. It shows up to two groups: this exact page, and the
          whole site.
        </P>
        <List>
          <LI>
            Each measurement shows the value that 75% of visits came in under, coloured by band,
            with a bar splitting all visits into good, needs improvement, and poor.
          </LI>
          <LI>
            It includes <Code>INP</Code> and <Code>TTFB</Code>, which lab audits cannot measure —
            how quickly the page responded to real taps, and how long the server took to answer.
          </LI>
          <LI>
            Quiet pages show <UiLabel>No CrUX data</UiLabel>. That is not a fault; there simply were
            not enough visitors to report on without identifying them.
          </LI>
        </List>

        <Callout tone="warn" label="Don’t mix engines in a comparison">
          PageSpeed runs are badged <Code>PSI</Code> and local runs <Code>LHA</Code> throughout the
          app. They were measured on different hardware, so a diff between one of each tells you
          about the machines as much as the page. Compare warns you when a page has both.
        </Callout>
      </DocsSection>

      <DocsSection
        id="agentic-browsing"
        index={docsPlate("agentic-browsing")}
        title="Agentic Browsing"
        lede="The fifth score. It grades the page for a different kind of visitor — an AI agent working on someone’s behalf — and it is worked out differently from the other four."
      >
        <P>
          Lighthouse 13.3 added a fifth category, and this app runs it with no extra setup: it is
          part of Lighthouse’s standard configuration, so an ordinary audit already produces it.
          Where Accessibility asks whether a person using a screen reader can operate the page,
          Agentic Browsing asks whether a piece of software sent to do a job — book the table, fill
          the form, find the price — can work out what is on the page and act on it.
        </P>
        <Callout tone="note" label="In Google’s words">
          “These checks ensure high-quality, browsable websites for AI agents and validate the
          correctness of WebMCP integrations. This category is still under development and subject
          to change.”
        </Callout>

        <H3>What it checks</H3>
        <P>
          Six checks. Two are about whether an agent can read the page at all — Google groups those
          as <em>Agent Accessibility</em> — three are about <Code>WebMCP</Code>, a browser feature a
          page uses to hand an agent named, described tools instead of making it guess at your
          buttons, and the last is layout stability, borrowed from the speed side of the audit.
        </P>
        <SpecList
          rows={[
            {
              term: "Accessibility tree",
              value: "agent-accessibility-tree",
              detail: (
                <>
                  Whether the page exposes a well-formed accessibility tree — the structure an agent
                  reads to work out what each control is. It reuses the same checks the
                  Accessibility category runs, narrowed to the ones that give a control a name:
                  button and link text, form labels, and the ARIA attributes that describe a widget.
                </>
              ),
            },
            {
              term: "llms.txt",
              value: "llms-txt",
              detail: (
                <>
                  Whether the site publishes an <Code>llms.txt</Code> — a Markdown file at the root
                  telling language models how you want the site read — and whether it follows the
                  community’s recommendations, which at minimum means real Markdown with at least
                  one <Code>#</Code> heading.
                </>
              ),
            },
            {
              term: "Registered tools",
              value: "webmcp-registered-tools",
              detail:
                "Lists the WebMCP tools the page had registered at the moment of the audit, with each one’s name, description and input schema. Informative — it reports what it found and does not affect the score.",
            },
            {
              term: "Form coverage",
              value: "webmcp-form-coverage",
              detail:
                "Lists the forms on the page and whether each carries WebMCP annotations, so an agent can fill it reliably rather than by inference. Also informative.",
            },
            {
              term: "Schema validity",
              value: "webmcp-schema-validity",
              detail:
                "Whether the registered tools’ schemas are valid — a missing tool name or an unnamed required parameter is a tool an agent cannot call correctly. Errors score zero; warnings alone score half.",
            },
            {
              term: "Layout stability",
              value: "cumulative-layout-shift",
              detail: (
                <>
                  The same <Code>CLS</Code> measurement that feeds the Performance score. A page that
                  jumps around while it loads is as hostile to an agent clicking the wrong element as
                  it is to a person.
                </>
              ),
            },
          ]}
        />

        <H3>Why the number moves in big steps</H3>
        <P>
          The score is an average of the checks above, exactly like the other four categories — but
          two things about this category’s checks change how it behaves.
        </P>
        <List>
          <LI>
            <strong className="font-medium text-foreground">Two of the six only report.</strong>{" "}
            Registered tools and form coverage are marked informative. They tell you what is there
            and are left out of the arithmetic entirely.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">
              Checks that do not apply are dropped, not failed.
            </strong>{" "}
            A site that serves no <Code>llms.txt</Code> and registers no WebMCP tools has those
            checks marked not applicable, and they leave the calculation rather than scoring zero.
            The category does not punish you for not having adopted WebMCP.
          </LI>
        </List>
        <P>
          On an ordinary site that leaves as few as two checks actually scoring: the accessibility
          tree and layout stability. One of them flipping therefore moves the score by up to half
          the scale. Google’s own report acknowledges this by showing the category as a fraction —{" "}
          <Code>1/2</Code>, how many of the checks that applied came out passing — rather than as a
          percentage.
          This app normalises it to 0–100 like every other ring, so the rings, tables, exports and
          thresholds all stay consistent, but the underlying number is a coarser instrument than
          Performance or SEO.
        </P>
        <Callout tone="warn" label="Read a change here as a signal, not a measurement">
          A 50-point drop in this category means one check started failing, not that the page got
          half as good. Open Google’s full report from the result to see which one it was — the
          category is listed there with each check’s own findings.
        </Callout>

        <H3>Why it is a category of its own</H3>
        <P>
          It grades a different audience. The other four are all about the experience of a person
          visiting the page; this one is about a program acting for them, which is a separate
          question with separate fixes. Keeping it separate is also honest about its maturity —
          Google says the category is still under development and subject to change, so the checks
          in it, and therefore the score, may move for reasons that have nothing to do with your
          page. Folding it into Accessibility or Performance would quietly shift numbers people
          already track.
        </P>

        <H3>Where you will see it</H3>
        <List>
          <LI>
            As a fifth ring and a fifth column everywhere scores appear — the live results panel,
            History, Compare and Batches — with its own pass threshold alongside the others.
          </LI>
          <LI>
            Short-labelled <Code>Agent</Code> where a column heading has no room for the full name.
          </LI>
          <LI>
            As one of the scores you can click to ask the AI why it came out that way, the same as
            any other category.
          </LI>
          <LI>
            On the <DocLink href="/pagespeed">PageSpeed</DocLink> page as well as the local engine.
            Google’s API accepts the category, so a PageSpeed audit scores it exactly like a local
            one — nothing on that page is hidden, disabled, or reported as a zero it did not
            measure.
          </LI>
        </List>

        <Callout tone="note" label="Audits you ran before this release">
          Older results have no Agentic Browsing score and never will — it was not measured at the
          time, and nothing can reconstruct it. They show an em dash, the same “not scored” mark
          described in <DocLink href="#reading-scores">Reading the scores</DocLink>, rather than a
          zero. Re-run a page if you want the fifth number for it.
        </Callout>
      </DocsSection>
    </>
  );
}
