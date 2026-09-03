/**
 * Manual chapters 09–11: the AI score analysis, choosing which AI runs it, and
 * connecting a research server so the answers cite real pages.
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

export function AiChapters() {
  return (
    <>
      <DocsSection
        id="ai-analysis"
        index={docsPlate("ai-analysis")}
        title="Ask why a score is low"
        lede="A score tells you there is a problem. The analysis tells you what it is, what to change, and where that advice came from."
      >
        <P>
          Lighthouse produces a long list of technical findings. Reading them and working out which
          three actually matter for your page is the slow part. The AI analysis does that reading
          for you: it takes the full audit, works out what is really dragging the score down, and
          writes back a diagnosis plus a short list of prioritised fixes with step-by-step
          instructions.
        </P>

        <H3>Running one</H3>
        <Steps>
          <Step title="Open a finished result">
            Click <UiLabel>View →</UiLabel> on any completed row, in the live results panel or in
            History.
          </Step>
          <Step title="Click the score you want explained">
            In the <UiLabel>Category scores</UiLabel> grid, each of the four scores is a button.
            Clicking one jumps to the Analysis tab already aimed at that category. You can also open
            the <UiLabel>Analysis</UiLabel> tab directly — it preselects whichever category scored
            worst.
          </Step>
          <Step title="Press Analyze">
            Watch the status line move through reading the audit, researching, and writing. If a
            research server is connected, every search and every page it opens appears in a live log
            underneath, so you can see exactly what it consulted.
          </Step>
        </Steps>

        <H3>What comes back</H3>
        <List>
          <LI>
            <strong className="font-medium text-foreground">Diagnosis</strong> — plain-language
            explanation of why this category scored what it did on this page.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Prioritised fixes</strong> — each one
            tagged High, Med or Low, with why it matters and numbered steps to apply it.
          </LI>
          <LI>
            <strong className="font-medium text-foreground">Sources</strong> — the pages the model
            actually read, when it was able to research. Every fix cites at least one.
          </LI>
        </List>

        <Callout tone="note" label="Read the badge at the bottom">
          The footer states which AI produced the analysis, which model, when, and what it cost if
          that is known. If nothing was cited it carries an amber{" "}
          <UiLabel>No web research</UiLabel> badge. That badge is the app being honest with you: the
          advice came from the audit data and the model’s own training, not from anything it looked
          up. It is still useful. It is just not sourced.
        </Callout>

        <P>
          An analysis is saved against that run and that category, so reopening the result shows it
          instantly and costs nothing. Press <UiLabel>Re-analyze</UiLabel> to spend a fresh request
          on it, or <UiLabel>Stop</UiLabel> to abandon one mid-flight.
        </P>

        <Callout tone="warn" label="Nothing is configured out of the box">
          If the Analysis tab says <UiLabel>Bring your own AI</UiLabel>, no provider is set up yet.
          The app ships no AI credentials, so nothing is billed to anyone but you. The next chapter
          sets this up in about a minute.
        </Callout>
      </DocsSection>

      <DocsSection
        id="ai-providers"
        index={docsPlate("ai-providers")}
        title="Claude, Ollama, or your own"
        lede="Three ways to power the analysis. You switch between them in Settings by clicking a button — no restart, no config file."
      >
        <P>
          Open <DocLink href="/settings">Settings</DocLink> and find{" "}
          <UiLabel>AI analysis provider</UiLabel>. Three cards are stacked there, one per option,
          each with its own button. Click the button and that provider handles the very next
          analysis. The active card turns green and says <UiLabel>Active</UiLabel> instead of
          offering a button.
        </P>
        <Callout tone="tip" label="No restart needed">
          Switching provider from Settings takes effect immediately. Only the endpoint and key for a
          custom provider have to come from <Code>.env</Code>, and only those need a restart. You
          can flip between Claude and a local model mid-session and analyse the same score twice to
          compare the answers.
        </Callout>

        <H3>Claude</H3>
        <P>
          The default, and the only option that can research the web and cite real sources. If you
          already use Claude Code on this machine, there is nothing to set up at all — the analysis
          uses the login you already have, on the subscription you already pay for. Otherwise sign
          in once:
        </P>
        <Terminal caption="terminal">{`claude login`}</Terminal>
        <P>
          To bill an API account rather than a subscription, put an{" "}
          <Code>ANTHROPIC_API_KEY</Code> in <Code>.env</Code> instead. Click{" "}
          <UiLabel>Use Claude</UiLabel> to select it.
        </P>

        <H3>Local Ollama</H3>
        <P>
          <DocLink href="https://ollama.com">Ollama</DocLink> runs a language model on your own
          machine. It is free, completely private, and works with no internet connection. Install
          Ollama, then pull a model:
        </P>
        <Terminal caption="terminal">{`ollama pull qwen2.5-coder:14b`}</Terminal>
        <P>
          Settings detects Ollama by itself. The card shows a{" "}
          <UiLabel>detected</UiLabel> badge and then lists every model you have installed as a row
          of pills, each with its size.{" "}
          <strong className="font-medium text-foreground">
            Clicking a model pill is the whole action
          </strong>{" "}
          — it selects Ollama and that specific model in one click. To try a different model, click
          a different pill. Nothing else to change, nothing to restart.
        </P>
        <Callout tone="warn" label="Size matters here">
          A full Lighthouse audit is a lot to reason about. Models of 14 billion parameters and up
          produce properly structured fixes; very small models often return prose instead, and the
          app degrades gracefully to a diagnosis rather than failing. Local models cannot browse, so
          their answers never carry citations and are badged{" "}
          <UiLabel>No web research</UiLabel>.
        </Callout>
        <P>
          If the card says nothing answered, start the service with <Code>ollama serve</Code>, or
          point <Code>OLLAMA_BASE_URL</Code> at wherever yours is listening.
        </P>

        <H3>Any OpenAI-compatible endpoint</H3>
        <P>
          Covers OpenAI itself, OpenRouter, LM Studio, vLLM, and anything else speaking the same
          protocol. The address and key must come from <Code>.env</Code>, because Settings never
          accepts a credential:
        </P>
        <Terminal caption=".env">
          {`LH_ANALYSIS_BASE_URL=https://api.example.com/v1
LH_ANALYSIS_API_KEY=your-key-here`}
        </Terminal>
        <P>
          Restart, then type the model id into the card’s <UiLabel>Model id</UiLabel> field and
          press <UiLabel>Use this endpoint</UiLabel>. The card shows only whether the address and key
          are present, never their values.
        </P>

        <H3>Which wins, Settings or .env?</H3>
        <P>
          A choice made in Settings overrides <Code>.env</Code> until you clear it with the{" "}
          <UiLabel>Use .env instead</UiLabel> button. The readout at the top of the panel always
          spells out where the current choice came from, so there is never any doubt about what will
          run next. If you prefer to configure it in the file, the panel has copyable snippets for
          all three.
        </P>

        <H3>At a glance</H3>
        <SpecList
          rows={[
            {
              term: "Claude",
              value: "web research",
              detail: (
                <>
                  Needs nothing if Claude Code is signed in here, or an{" "}
                  <Code>ANTHROPIC_API_KEY</Code>. The only provider that can cite sources. Optionally
                  pin a model with <Code>LH_ANALYSIS_MODEL</Code>.
                </>
              ),
            },
            {
              term: "Ollama",
              value: "private, offline",
              detail: (
                <>
                  Needs a model installed. Pick it by clicking a pill in Settings, or set{" "}
                  <Code>LH_ANALYSIS_MODEL</Code>. Optional{" "}
                  <Code>OLLAMA_BASE_URL</Code> if it runs somewhere unusual. No web research.
                </>
              ),
            },
            {
              term: "OpenAI-compatible",
              value: "bring your own",
              detail: (
                <>
                  Needs <Code>LH_ANALYSIS_BASE_URL</Code> and a model id, plus{" "}
                  <Code>LH_ANALYSIS_API_KEY</Code> if the endpoint requires one. No web research.
                </>
              ),
            },
          ]}
        />
        <P>
          Keys are read from the environment at the moment they are needed and are never written to
          the database, the reports, the logs, or anything sent to your browser.
        </P>
      </DocsSection>

      <DocsSection
        id="web-research"
        index={docsPlate("web-research")}
        title="Give the AI the web"
        lede="Optional. Connect a research server and every recommendation cites a page the model actually opened and read."
      >
        <P>
          Without this, analysis still works — it reasons from your audit data alone, and says so.
          With it, Claude can search for the current fix for your specific problem, read the pages
          it finds, and attach them as sources. Advice about the web ages quickly, so this is the
          difference between a plausible answer and a checkable one.
        </P>
        <Callout tone="note">
          Web research only applies to the Claude provider. Local and OpenAI-compatible models do not
          drive research tools in this app.
        </Callout>

        <H3>The easy way: CrawlForge</H3>
        <P>
          One switch in <DocLink href="/settings">Settings</DocLink> →{" "}
          <UiLabel>Web research</UiLabel>, and no configuration file to write. It is off by default.
        </P>
        <Steps>
          <Step title="Get a free key">
            Sign up at <DocLink href="https://www.crawlforge.dev">crawlforge.dev</DocLink>. It comes
            with 1,000 credits and needs no card.
          </Step>
          <Step title="Run the setup command once">
            <Terminal caption="terminal">{`npx crawlforge-setup`}</Terminal>
            It checks the key and stores it in its own configuration file in your home folder.
            LightAudit only ever checks that the file exists — it never opens it, and never passes
            the key anywhere.
          </Step>
          <Step title="Turn the switch on">
            The next analysis will search and read the web. The first one takes a few extra seconds
            while the server downloads; after that it starts from a local cache.
          </Step>
        </Steps>
        <P>
          Credits are spent on your own CrawlForge account. The app deliberately limits the analysis
          to searching and page-reading, so a single analysis costs a handful of credits rather than
          crawling a whole site. To run a newer release than the pinned one, set{" "}
          <Code>LH_CRAWLFORGE_VERSION=x.y.z</Code> in <Code>.env</Code>.
        </P>

        <H3>The advanced way: any MCP server</H3>
        <P>
          CrawlForge is one option, not a requirement. Any server offering web search and page
          fetching works. Declare it as <Code>research</Code> under <Code>mcpServers</Code> in an{" "}
          <Code>.mcp.json</Code> file in the project folder.
        </P>
        <List>
          <LI>
            <Code>LH_RESEARCH_MCP_CONFIG</Code> points at a configuration file somewhere else.
          </LI>
          <LI>
            <Code>LH_RESEARCH_MCP_SERVER</Code> selects a differently-named server inside it.
          </LI>
          <LI>
            If the CrawlForge switch is on, it takes precedence over a custom server. The panel says
            so.
          </LI>
        </List>
        <Callout tone="warn" label="It runs as its own program">
          A research server is separate software you install and authenticate yourself. It runs
          under your control and spends your credits. LightAudit never stores or forwards its
          credentials — so prefer servers that read their own configuration rather than expecting a
          key to be handed to them.
        </Callout>
      </DocsSection>
    </>
  );
}
