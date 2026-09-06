"use client";

/**
 * "Authentication" disclosure for the audit control bar (ROADMAP Phase B).
 *
 * Three credential mechanisms — an HTTP basic-auth pair, cookie pairs, and
 * arbitrary request headers — folded into one collapsed-by-default panel that
 * feeds BOTH the audit and the crawl. A protected staging site is exactly the
 * case where you discover the pages first and audit them second, so the two
 * share one credential block rather than asking for it twice.
 *
 * ## Why it is collapsed, and why it is here at all
 *
 * The overwhelmingly common audit is unauthenticated. A permanently-expanded
 * six-input panel would put a rarely-used form in the middle of the instrument
 * every user sees, so this stays one row until asked for — with a live status
 * chip on the trigger, so a run that *will* authenticate never does so silently.
 * It sits in Run config rather than Targets because a credential is a property
 * of the run, not of the URL list, and because both target tabs need it.
 *
 * ## Why the state is a plain `useState` in the parent (do not "fix" this)
 *
 * `NewAuditForm` persists nearly everything it holds: run dials go to
 * `localStorage` via `useAuditDefaults`, and the targets draft goes to
 * `sessionStorage` via `useLocalAuditDraft`. The credential is the ONE piece of
 * form state that must reach neither — these are the audited site's secrets, not
 * LightAudit Score's, and a browser store is a file on disk that outlives the
 * batch. So this component is fully controlled, its value lives in a plain
 * `useState` in the parent, and it dies with the page. The inconsistency with
 * every other control in that form is deliberate; see `.claude/rules/security.md`.
 *
 * Validation mirrors `auditOptionsSchema` through
 * {@link resolveCredentialDraft} so a malformed header name is a message beside
 * the input rather than a 400 after pressing Run. The server remains the
 * authority — this only saves the round trip.
 */

import { useCallback, useId, useRef, type ReactNode } from "react";
import { KeyRound, Plus, TriangleAlert, X } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Readout } from "@/components/audit/readout";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  ENV_BASIC_AUTH,
  ENV_COOKIES,
  ENV_EXTRA_HEADERS,
  MAX_CREDENTIAL_ENTRIES,
  REDACTED,
} from "@/lib/lighthouse/credentials";
import {
  type CredentialDraft,
  type CredentialResolution,
  type CredentialRow,
  type CredentialRowError,
  emptyCredentialRow,
  summarizeCredentials,
} from "@/components/audit/credential-draft";

/**
 * Shared column template for a name/value row and its header captions. Declared
 * once so the captions can never drift out of alignment with the inputs they
 * name. The trailing `2rem` is the remove button (`size="icon"` → `size-8`).
 */
const ROW_GRID =
  "@sm:grid @sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_2rem] @sm:items-start @sm:gap-2";

/** Monospace micro-cap, the data accent used across the audit surfaces. */
const MICRO_CAP =
  "font-mono text-[0.6rem] font-medium uppercase tracking-[0.18em]";

/**
 * A literal identifier inside prose — a header name, an env var, a marker.
 * `translate="no"` because these are code tokens: a browser's auto-translate
 * happily turns `Cookie` into `Galleta` and hands the user an instruction that
 * does not work.
 */
function Token({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-xs" translate="no">
      {children}
    </span>
  );
}

// --- One name/value row ----------------------------------------------------

interface CredentialRowFieldsProps {
  row: CredentialRow;
  /** Singular noun for the labels, e.g. "Cookie" / "Header". */
  noun: string;
  namePlaceholder: string;
  valuePlaceholder: string;
  /** This row's failure, or undefined when it is valid. */
  error?: CredentialRowError;
  disabled: boolean;
  onChange: (row: CredentialRow) => void;
  onRemove: (id: string) => void;
}

/**
 * A single editable pair.
 *
 * Both inputs carry a real `<label>`: visible while the row is stacked on a
 * narrow column, `sr-only` once the caption row above takes over at `@sm`. The
 * error is scoped to the half that caused it ({@link CredentialRowError.field}),
 * so `aria-invalid` and the `aria-describedby` target land on the input the user
 * actually has to fix.
 */
function CredentialRowFields({
  row,
  noun,
  namePlaceholder,
  valuePlaceholder,
  error,
  disabled,
  onChange,
  onRemove,
}: CredentialRowFieldsProps) {
  const nameId = useId();
  const valueId = useId();
  const errorId = useId();

  const nameInvalid = error?.field === "name";
  const valueInvalid = error?.field === "value";
  const lower = noun.toLowerCase();

  return (
    <div className={cn("flex flex-col gap-3", ROW_GRID)}>
      <Field data-invalid={nameInvalid || undefined} className="gap-1">
        <FieldLabel htmlFor={nameId} className="@sm:sr-only">
          {noun} name
        </FieldLabel>
        <Input
          id={nameId}
          value={row.name}
          onChange={(event) => onChange({ ...row, name: event.target.value })}
          disabled={disabled}
          aria-invalid={nameInvalid || undefined}
          aria-describedby={nameInvalid ? errorId : undefined}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={namePlaceholder}
        />
      </Field>

      <Field data-invalid={valueInvalid || undefined} className="gap-1">
        <FieldLabel htmlFor={valueId} className="@sm:sr-only">
          {noun} value
        </FieldLabel>
        <Input
          id={valueId}
          value={row.value}
          onChange={(event) => onChange({ ...row, value: event.target.value })}
          disabled={disabled}
          aria-invalid={valueInvalid || undefined}
          aria-describedby={valueInvalid ? errorId : undefined}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={valuePlaceholder}
        />
      </Field>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => onRemove(row.id)}
        disabled={disabled}
        // The row's own name is the only thing that distinguishes one remove
        // button from the next in a list of them.
        aria-label={
          row.name.trim().length > 0
            ? `Remove ${lower} ${row.name.trim()}`
            : `Remove empty ${lower} row`
        }
        className="self-end text-muted-foreground hover:text-destructive @sm:self-start"
      >
        <X />
      </Button>

      {/* One message per row, spanning the full width beneath it. `FieldError`
          is role=alert, so a message that appears as you type is announced. */}
      {error ? (
        <FieldError id={errorId} className="@sm:col-span-3">
          {error.message}
        </FieldError>
      ) : null}
    </div>
  );
}

// --- A list of rows --------------------------------------------------------

interface CredentialRowListProps {
  legend: string;
  description: ReactNode;
  noun: string;
  namePlaceholder: string;
  valuePlaceholder: string;
  rows: CredentialRow[];
  errors: Record<string, CredentialRowError>;
  disabled: boolean;
  onRowsChange: (rows: CredentialRow[]) => void;
  /** Mints a key for a freshly added row (see {@link CredentialRow.id}). */
  nextRowId: () => string;
}

/** A labelled, repeatable name/value list with add/remove. */
function CredentialRowList({
  legend,
  description,
  noun,
  namePlaceholder,
  valuePlaceholder,
  rows,
  errors,
  disabled,
  onRowsChange,
  nextRowId,
}: CredentialRowListProps) {
  // Plain functions, not `useCallback`: every dependency (`rows`, and an
  // `onRowsChange` closed over the parent's draft) changes on every keystroke,
  // so memoising them would allocate a deps array to hand back a new function
  // regardless. Nothing below is memoised, so identity buys nothing either.
  function handleChange(next: CredentialRow) {
    onRowsChange(rows.map((row) => (row.id === next.id ? next : row)));
  }

  function handleRemove(id: string) {
    onRowsChange(rows.filter((row) => row.id !== id));
  }

  function handleAdd() {
    onRowsChange([...rows, emptyCredentialRow(nextRowId())]);
  }

  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label">{legend}</FieldLegend>
      <FieldDescription className="-mt-1">{description}</FieldDescription>

      {rows.length > 0 ? (
        <div className="flex flex-col gap-3">
          {/* Caption row: decorative, and only where the grid is actually two
              columns. Below `@sm` each input shows its own visible label
              instead, so neither width leaves an input named by a placeholder. */}
          <div
            aria-hidden
            className={cn("hidden", ROW_GRID, "text-muted-foreground", MICRO_CAP)}
          >
            <span>Name</span>
            <span>Value</span>
            <span />
          </div>
          {rows.map((row) => (
            <CredentialRowFields
              key={row.id}
              row={row}
              noun={noun}
              namePlaceholder={namePlaceholder}
              valuePlaceholder={valuePlaceholder}
              error={errors[row.id]}
              disabled={disabled}
              onChange={handleChange}
              onRemove={handleRemove}
            />
          ))}
        </div>
      ) : null}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleAdd}
        disabled={disabled || rows.length >= MAX_CREDENTIAL_ENTRIES}
        className="self-start"
      >
        <Plus data-icon="inline-start" />
        Add {noun.toLowerCase()}
      </Button>
    </FieldSet>
  );
}

// --- The disclosure --------------------------------------------------------

export interface AuthDisclosureProps {
  /**
   * The credential draft. Fully controlled: it lives in a plain `useState` in
   * the parent and is never persisted — see this file's docblock.
   */
  value: CredentialDraft;
  onChange: (draft: CredentialDraft) => void;
  /**
   * The parent's already-memoised {@link resolveCredentialDraft} result. Passed
   * in rather than recomputed here because the parent needs the same object for
   * the submit gate, the crawl request and the run-config readout — one
   * resolution, one set of messages, no chance of the panel and the gate
   * disagreeing about whether the draft is valid.
   */
  resolution: CredentialResolution;
  /** Locks every input while a batch from this form is running. */
  disabled?: boolean;
}

export function AuthDisclosure({
  value,
  onChange,
  resolution,
  disabled = false,
}: AuthDisclosureProps) {
  const usernameId = useId();
  const passwordId = useId();
  const usernameErrorId = useId();
  const passwordErrorId = useId();

  // Row keys. A `useId` prefix keeps them unique against any other list on the
  // page; the counter only ever advances inside an event handler, so render
  // stays pure and SSR and the client agree on the ids that already exist.
  const rowIdPrefix = useId();
  const rowCounter = useRef(0);
  const nextRowId = useCallback(
    () => `${rowIdPrefix}-row-${rowCounter.current++}`,
    [rowIdPrefix],
  );

  const { errors, warnings, credentials, hasErrors } = resolution;

  // Same reasoning as `CredentialRowList`: these close over `value`, so they are
  // new on every keystroke whether or not they are wrapped.
  function setBasicAuth(patch: Partial<CredentialDraft["basicAuth"]>) {
    onChange({ ...value, basicAuth: { ...value.basicAuth, ...patch } });
  }
  function setCookies(cookies: CredentialRow[]) {
    onChange({ ...value, cookies });
  }
  function setHeaders(headers: CredentialRow[]) {
    onChange({ ...value, headers });
  }

  // The trigger's status chip — the whole reason this can be collapsed by
  // default. "Off" is the honest resting state; a summary means the next run
  // authenticates; an error means it will not run at all until fixed.
  const status = hasErrors
    ? { text: "Check fields", tone: "text-destructive" }
    : credentials
      ? { text: summarizeCredentials(credentials), tone: "text-score-good" }
      : { text: "Off", tone: "text-muted-foreground" };

  return (
    <Accordion
      type="single"
      collapsible
      // Own container so the row grid measures THIS panel rather than whatever
      // column it has been dropped into.
      className="@container w-full rounded-lg border border-border/60 bg-muted/30 px-3"
    >
      <AccordionItem value="authentication" className="border-b-0">
        <AccordionTrigger className="hover:no-underline">
          <span className="flex flex-1 items-center justify-between gap-3 pr-2">
            <span className="flex items-center gap-2 group-hover/accordion-trigger:underline">
              <KeyRound className="size-3.5 text-muted-foreground" aria-hidden />
              Authentication
            </span>
            <span className={cn(MICRO_CAP, status.tone)}>{status.text}</span>
          </span>
        </AccordionTrigger>

        <AccordionContent className="flex flex-col gap-5 pb-4">
          {/* The promise that makes typing a credential here reasonable. It
              leads the panel because it has to be read before the first
              keystroke, not after. */}
          <FieldDescription className="text-pretty">
            Held in memory for this batch only — never written to disk, to the
            database, or to a report. The run&rsquo;s history record keeps the
            header and cookie <em>names</em> so you can see what a run
            authenticated with; every value is stored as{" "}
            <Token>{REDACTED}</Token>. Applies to the
            local Chrome engine and to crawl discovery, so a protected staging
            site can be discovered and then audited with one set of credentials.
          </FieldDescription>
          {/*
            Transmission scope, stated up front. Chrome applies these headers per
            PAGE, not per origin, so they ride every request the audited page
            makes — including third-party subresources. Scoping them to the
            site's own origin would mean intercepting every request over CDP,
            which measurably distorts the timings this tool exists to measure, so
            we tell the user instead of quietly doing either. See
            `buildCredentialFlags` in `src/lib/lighthouse/runAudit.ts`.
          */}
          <FieldDescription>
            Chrome sends these headers on <em>every</em> request the page makes,
            including to third parties it loads (fonts, analytics, CDNs). Use a
            credential scoped to the site you are auditing — a staging or preview
            token rather than a production session.
          </FieldDescription>

          <FieldSet className="gap-2">
            <FieldLegend variant="label">Basic auth</FieldLegend>
            <FieldDescription className="-mt-1">
              Sent as an <Token>Authorization</Token>{" "}
              header. Leave blank if the site does not use HTTP basic auth.
            </FieldDescription>
            {/* Borrows the rows' column template — including their empty
                remove-button column — so every input in the panel lands on the
                same two edges rather than the pair sitting proud of the lists. */}
            <div className={cn("flex flex-col gap-3", ROW_GRID)}>
              <Field
                data-invalid={errors.username !== null || undefined}
                className="gap-1"
              >
                <FieldLabel htmlFor={usernameId}>Username</FieldLabel>
                <Input
                  id={usernameId}
                  value={value.basicAuth.username}
                  onChange={(event) =>
                    setBasicAuth({ username: event.target.value })
                  }
                  disabled={disabled}
                  aria-invalid={errors.username !== null || undefined}
                  aria-describedby={
                    errors.username !== null ? usernameErrorId : undefined
                  }
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder="staging"
                />
              </Field>
              <Field
                data-invalid={errors.password !== null || undefined}
                className="gap-1"
              >
                <FieldLabel htmlFor={passwordId}>Password</FieldLabel>
                {/* No `name`, and no enclosing `<form>`: both are deliberate.
                    A named password field inside a form is exactly what trips
                    Chrome's "save this password?" heuristic, and the whole point
                    of this panel is that the credential is NOT saved anywhere —
                    including in the user's password manager, which would
                    quietly reintroduce the persistence we just removed. */}
                <Input
                  id={passwordId}
                  type="password"
                  value={value.basicAuth.password}
                  onChange={(event) =>
                    setBasicAuth({ password: event.target.value })
                  }
                  disabled={disabled}
                  aria-invalid={errors.password !== null || undefined}
                  aria-describedby={
                    errors.password !== null ? passwordErrorId : undefined
                  }
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
              </Field>
              {errors.username !== null ? (
                <FieldError id={usernameErrorId} className="@sm:col-span-3">
                  {errors.username}
                </FieldError>
              ) : null}
              {errors.password !== null ? (
                <FieldError id={passwordErrorId} className="@sm:col-span-3">
                  {errors.password}
                </FieldError>
              ) : null}
            </div>
          </FieldSet>

          <Separator />

          <CredentialRowList
            legend="Cookies"
            description={
              <>
                Serialised into one{" "}
                <Token>Cookie</Token> header. Names
                follow the same grammar as headers; values may not contain{" "}
                <Token>;</Token> or line breaks.
              </>
            }
            noun="Cookie"
            namePlaceholder="session"
            valuePlaceholder="paste the value…"
            rows={value.cookies}
            errors={errors.cookies}
            disabled={disabled}
            onRowsChange={setCookies}
            nextRowId={nextRowId}
          />

          <Separator />

          <CredentialRowList
            legend="Request headers"
            description={
              <>
                Sent on every request. Names may contain letters, digits and{" "}
                <Token>!#$%&amp;&apos;*+-.^_`|~</Token>{" "}
                — no spaces or colons; values may not contain line breaks. Up to{" "}
                {MAX_CREDENTIAL_ENTRIES} of each.
              </>
            }
            noun="Header"
            namePlaceholder="X-Preview-Token"
            valuePlaceholder="paste the token…"
            rows={value.headers}
            errors={errors.headers}
            disabled={disabled}
            onRowsChange={setHeaders}
            nextRowId={nextRowId}
          />

          {errors.panel.length > 0 ? (
            <FieldError>
              <ul className="ml-4 flex list-disc flex-col gap-1">
                {errors.panel.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </FieldError>
          ) : null}

          {warnings.length > 0 ? (
            <Alert aria-live="polite">
              <TriangleAlert className="text-score-average" />
              <AlertDescription>
                <ul className="flex list-disc flex-col gap-1 pl-4">
                  {warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          {/* The other route in, for anything you type more than once. */}
          <Readout className="gap-2">
            <p className={cn(MICRO_CAP, "text-muted-foreground")}>
              Reusing the same values
            </p>
            <FieldDescription className="text-pretty">
              Put them in <Token>.env</Token> as{" "}
              <Token>{ENV_BASIC_AUTH}</Token> (
              <Token>user:password</Token>),{" "}
              <Token>{ENV_EXTRA_HEADERS}</Token> (a
              JSON object) or{" "}
              <Token>{ENV_COOKIES}</Token> (a{" "}
              <Token>Cookie</Token>-header string or
              JSON). Those are read inside the audit worker and never travel
              through the browser at all. Anything typed above layers over them
              for this batch.
            </FieldDescription>
            <FieldDescription className="text-pretty">
              PageSpeed Insights runs on Google&rsquo;s servers, which cannot
              reach a page only this machine can — so the PageSpeed form has no
              Authentication panel, and neither route applies to it.
            </FieldDescription>
          </Readout>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
