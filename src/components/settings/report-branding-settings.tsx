"use client";

/**
 * Report header — the optional title / logo / date block printed at the top of
 * an exported client report (ROADMAP Phase H).
 *
 * Every other panel on this page is read-only status plus guidance, because
 * everything else on this page is credential-shaped and credentials live in
 * `.env`. This one is a FORM, and it is a form for exactly the reason the
 * others are not: none of it is a secret. A name, a strapline, a picture and a
 * boolean are the auditor's own letterhead, they belong in `app_settings` with
 * the other non-secret preferences, and there is nowhere else for the user to
 * put them (`.claude/rules/security.md`).
 *
 * Three things drive the design:
 *
 *  - **The preview is the panel.** What matters is not "did the field save" but
 *    "what will my client see at the top of this document", so the block is
 *    drawn as a sheet of paper rather than as app chrome, and it updates as you
 *    type. The controls are arranged around it, not the other way round.
 *  - **The server has the last word.** `PUT` answers with what was ACTUALLY
 *    stored, and this panel repaints from that rather than from what it sent.
 *    A logo the browser was happy to read can still be refused by the store's
 *    allow-list, and the user has to find that out here, not from a client who
 *    opens the report to a broken image.
 *  - **A refusal is explained twice.** SVG and oversized files are rejected in
 *    the picker with a toast that says why, AND on the server. The client check
 *    is the courtesy; the server check is the security boundary. See
 *    `sanitizeBranding` in `@/lib/settings/branding` for what that boundary is
 *    actually defending — an HTML file the user forwards to a client.
 */

import { useCallback, useEffect, useEffectEvent, useId, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleDashed,
  ImagePlus,
  Loader2,
  PencilLine,
  Stamp,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getReportBranding, saveReportBranding } from "@/lib/client/reportBranding";
import {
  BRANDING_LIMITS,
  EMPTY_BRANDING,
  sanitizeLogoDataUri,
  type ReportBranding,
} from "@/lib/export/report-model";
import { cn } from "@/lib/utils";

/*
 * The caps and the type allow-list come from `BRANDING_LIMITS` in the
 * `report-model` contract, which the store re-exports and enforces server-side.
 * They are read rather than restated: this panel and the store have to agree on
 * what "too big" and "an image" mean, and three hand-copied numbers in two files
 * agree only until someone changes one of them.
 *
 * The contract module is where they can live — it is types and constants with no
 * Node imports, so a client component can import it, while the store itself
 * reaches SQLite and would drag `better-sqlite3` into the browser bundle.
 *
 * This check is a courtesy, not the boundary: it turns an oversized or wrong-typed
 * file into an immediate sentence instead of a round-trip. The server sanitises
 * independently and answers with what it actually stored, so anything this UI
 * waves through comes back as `""` and the panel repaints without it.
 */
const TITLE_MAX = BRANDING_LIMITS.titleMax;
const SUBTITLE_MAX = BRANDING_LIMITS.subtitleMax;
const LOGO_MAX_BYTES = BRANDING_LIMITS.logoMaxBytes;

/** What the picker offers. SVG is absent by decision — see {@link BRANDING_LIMITS}. */
const LOGO_ACCEPT = BRANDING_LIMITS.logoMimeTypes
  .map((subtype) => `image/${subtype}`)
  .join(",");

/** The types the store will actually keep, as the file picker sees them. */
const LOGO_MIME_TYPES = new Set(
  BRANDING_LIMITS.logoMimeTypes.map((subtype) => `image/${subtype}`),
);

/*
 * What `FileReader` hands back is validated with the SAME function the server
 * uses — `sanitizeLogoDataUri` from the contract — rather than a third copy of
 * the rule. Phase H's security review counted three hand-rolled versions of this
 * check across the codebase; there is now one, and it is pure, so a client
 * component can call it without pulling SQLite into the bundle.
 */

/** Two branding records the user would call the same. */
function sameBranding(a: ReportBranding, b: ReportBranding): boolean {
  return (
    a.title === b.title &&
    a.subtitle === b.subtitle &&
    a.logoDataUri === b.logoDataUri &&
    a.showDate === b.showDate
  );
}

/**
 * Kilobytes, for a message about a file the user just chose. The space is
 * non-breaking: "256" and "KB" are one token to a reader, and a wrap between
 * them in a toast reads as two numbers.
 */
function formatKb(bytes: number): string {
  return `${Math.round(bytes / 1024).toLocaleString()}\u00a0KB`;
}

/**
 * Why a chosen file cannot be a logo, or `null` when it can be. The reasons are
 * separate strings on purpose: "that is an SVG" and "that is 4 MB" call for
 * different fixes, and a single "invalid image" would send the user to guess.
 */
function rejectLogoFile(file: File): string | null {
  const isSvg = file.type === "image/svg+xml" || /\.svgz?$/i.test(file.name);
  if (isSvg) {
    return "SVG logos aren't accepted — an SVG is a document that can carry scripts, and this one would be embedded in a file you send to a client. Export it as PNG.";
  }
  if (!LOGO_MIME_TYPES.has(file.type)) {
    return "Choose a PNG, JPEG, WEBP or GIF image.";
  }
  if (file.size > LOGO_MAX_BYTES) {
    return `That image is ${formatKb(file.size)}. The logo is embedded in every exported report, so it has to stay under ${formatKb(LOGO_MAX_BYTES)} — try exporting it at around 400px wide.`;
  }
  return null;
}

export function ReportBrandingSettings() {
  /** The server's copy: `null` until read, and `null` again if the read failed. */
  const [stored, setStored] = useState<ReportBranding | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<ReportBranding>(EMPTY_BRANDING);
  const [saving, setSaving] = useState(false);

  const titleId = useId();
  const subtitleId = useId();
  const logoInputId = useId();
  const logoGroupId = useId();
  const showDateId = useId();
  const statusId = useId();

  // Pure read — no setState, so it's safe to call synchronously from an effect.
  const fetchBranding = useCallback(() => getReportBranding(), []);

  // State is applied in an effect-event, keeping setState out of reactive effect
  // scope — the codebase's mount-fetch pattern.
  const applyBranding = useEffectEvent((value: ReportBranding | null) => {
    setStored(value);
    if (value) setDraft(value);
    setLoading(false);
  });
  useEffect(() => {
    const controller = new AbortController();
    void fetchBranding().then((value) => {
      if (!controller.signal.aborted) applyBranding(value);
    });
    return () => controller.abort();
  }, [fetchBranding]);

  // Derived during render rather than mirrored into state: a `dirty` flag kept
  // in an effect is the classic way for a Save button to disagree with the form.
  const ready = !loading && stored !== null;
  const unreadable = !loading && stored === null;
  const dirty = stored !== null && !sameBranding(stored, draft);
  const canEdit = ready && !saving;
  const canSave = dirty && canEdit;
  const hasHeader = Boolean(draft.title || draft.subtitle || draft.logoDataUri);

  // A typed-out header is easy to lose to a reload, and unlike the switches on
  // this page nothing here saves itself. The listener is attached only while
  // there is something to lose, and `dirty` is a primitive so the effect
  // re-runs on the transition rather than on every keystroke.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const patch = useCallback(
    (fields: Partial<ReportBranding>) =>
      setDraft((current) => ({ ...current, ...fields })),
    [],
  );

  function handleLogoPick(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Cleared straight away so re-picking the SAME file still fires `change` —
    // otherwise "choose it again after a failed one" silently does nothing.
    input.value = "";
    if (!file) return;

    const rejection = rejectLogoFile(file);
    if (rejection) {
      toast.error("That file can't be used as a logo", { description: rejection });
      return;
    }

    const reader = new FileReader();
    reader.onerror = () =>
      toast.error("That image couldn't be read", {
        description: "The file may be corrupt. Try exporting it again.",
      });
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      // Literally the server's function, so the panel cannot accept something
      // the store will then silently drop. Reached when the browser gave the
      // file a type its bytes don't match, and — since this validates the body
      // and the decoded size too, not just the prefix — when the image is too
      // large or the encoding is malformed.
      const clean = sanitizeLogoDataUri(result);
      if (!clean) {
        toast.error("That file can't be used as a logo", {
          description: `It didn't read as a PNG, JPEG, WEBP or GIF under ${formatKb(LOGO_MAX_BYTES)}.`,
        });
        return;
      }
      patch({ logoDataUri: clean });
    };
    reader.readAsDataURL(file);
  }

  function handleSave() {
    if (!canSave || stored === null) return;
    const sent = draft;
    setSaving(true);
    saveReportBranding(sent)
      .then((next) => {
        setStored(next);
        setDraft(next);
        // The one case worth interrupting for: the store refused the logo after
        // the picker accepted it. Saying "saved" here would be a lie the user
        // only discovers in front of a client.
        if (sent.logoDataUri && !next.logoDataUri) {
          toast.warning("Saved without the logo", {
            description: "The image wasn't accepted. Try a PNG under 256 KB.",
          });
        } else {
          toast.success("Report header saved.");
        }
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : "Could not save the report header.");
      })
      .finally(() => setSaving(false));
  }

  return (
    <section className="rounded-lg border border-border/60 bg-card/40">
      {/* instrument header strip */}
      <header className="flex items-center justify-between gap-4 border-b border-border/60 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-md border border-border/70 bg-background/60 text-primary">
            <Stamp className="size-4" aria-hidden="true" />
          </span>
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">
              Report header
            </h2>
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
              Optional · Exported client reports
            </span>
          </div>
        </div>
        <StatusPill loading={loading} unreadable={unreadable} configured={hasHeader} />
      </header>

      <div className="flex flex-col gap-5 px-5 py-5">
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Exporting a batch produces one self-contained HTML file you can send to
          a client. This block is printed above the report&rsquo;s own title, so
          the document arrives under your name rather than ours. Leave it empty
          and the report simply opens with its own masthead &mdash; the audit
          title, the batch id and how the batch was run.
        </p>

        {unreadable ? (
          <p
            className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-400"
            role="status"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              Couldn&apos;t read the saved header, so editing is switched off
              rather than risk overwriting it. Reload the page to try again.
            </span>
          </p>
        ) : null}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          {/* ---- controls ---- */}
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor={titleId}>Title</FieldLabel>
              <Input
                id={titleId}
                name="report-title"
                type="text"
                value={draft.title}
                onChange={(event) => patch({ title: event.target.value })}
                placeholder="Northwind Audits"
                maxLength={TITLE_MAX}
                disabled={!canEdit}
                autoComplete="organization"
                className="text-sm"
              />
              <p className="font-mono text-[0.65rem] text-muted-foreground">
                Your name or your agency&apos;s. Up to {TITLE_MAX} characters.
              </p>
            </Field>

            <Field>
              <FieldLabel htmlFor={subtitleId}>Strapline</FieldLabel>
              <Input
                id={subtitleId}
                name="report-subtitle"
                type="text"
                value={draft.subtitle}
                onChange={(event) => patch({ subtitle: event.target.value })}
                placeholder="Quarterly performance review"
                maxLength={SUBTITLE_MAX}
                disabled={!canEdit}
                autoComplete="off"
                className="text-sm"
              />
              <p className="font-mono text-[0.65rem] text-muted-foreground">
                One line under the title. Optional.
              </p>
            </Field>

            {/* The file input's own accessible name is the button text
                ("Choose image"), so the group carries the field name instead —
                a second <label> on the input would fight the first. */}
            <div role="group" aria-labelledby={logoGroupId} className="flex flex-col gap-2">
              <span
                id={logoGroupId}
                className="text-sm leading-none font-medium text-foreground"
              >
                Logo
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {/* `peer` + `sr-only`: the input stays a real, focusable form
                    control (so the keyboard and the a11y tree both work), and
                    the styled <label> is what is seen and clicked. */}
                <input
                  id={logoInputId}
                  name="report-logo"
                  type="file"
                  accept={LOGO_ACCEPT}
                  onChange={handleLogoPick}
                  disabled={!canEdit}
                  className="peer sr-only"
                />
                <label
                  htmlFor={logoInputId}
                  className={cn(
                    "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-sm font-medium transition-colors",
                    "hover:bg-muted hover:text-foreground",
                    "peer-focus-visible:border-ring peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50",
                    "peer-disabled:pointer-events-none peer-disabled:opacity-50",
                  )}
                >
                  <ImagePlus className="size-3.5" aria-hidden="true" />
                  {draft.logoDataUri ? "Replace image" : "Choose image"}
                </label>
                {draft.logoDataUri ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!canEdit}
                    onClick={() => patch({ logoDataUri: "" })}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    Remove logo
                  </Button>
                ) : null}
              </div>
              <p className="font-mono text-[0.65rem] text-muted-foreground">
                PNG, JPEG, WEBP or GIF · under {formatKb(LOGO_MAX_BYTES)} · no SVG
              </p>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border/60 bg-background/50 px-4 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <Label htmlFor={showDateId} className="text-sm font-medium">
                  Print the date
                </Label>
                <p className="font-mono text-[0.65rem] text-muted-foreground">
                  {draft.showDate
                    ? "The report says when it was generated."
                    : "The report carries no date."}
                </p>
              </div>
              {/* Named by the visible <Label htmlFor> above; an aria-label here
                  would replace that text with a different one. */}
              <Switch
                id={showDateId}
                checked={draft.showDate}
                onCheckedChange={(showDate) => patch({ showDate })}
                disabled={!canEdit}
              />
            </div>
          </div>

          {/* ---- live preview ---- */}
          <HeaderPreview branding={draft} ready={ready} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 pt-4">
          {/* The polite region is the SAVE STATUS, not the preview: announcing
              the header block on every keystroke would make the panel unusable
              with a screen reader. This says one short sentence, when it
              changes. */}
          <p
            id={statusId}
            aria-live="polite"
            className={cn(
              "flex items-center gap-2 text-sm",
              dirty ? "text-amber-400" : "text-muted-foreground",
            )}
          >
            {saving ? (
              <>
                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
                <span>Saving…</span>
              </>
            ) : dirty ? (
              <>
                <PencilLine className="size-4 shrink-0" aria-hidden="true" />
                <span>Unsaved changes.</span>
              </>
            ) : ready ? (
              <>
                <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                <span>Saved. The next export uses this header.</span>
              </>
            ) : (
              <>
                <CircleDashed className="size-4 shrink-0" aria-hidden="true" />
                <span>{unreadable ? "Not editable." : "Loading…"}</span>
              </>
            )}
          </p>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!canSave}
              onClick={() => {
                if (stored) setDraft(stored);
              }}
            >
              Revert
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canSave}
              onClick={handleSave}
              aria-describedby={statusId}
            >
              Save header
            </Button>
          </div>
        </div>

        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Nothing here is a credential — a name, a strapline, a picture and a
          switch — so unlike the panels above, these are stored by the app
          rather than read from{" "}
          <span className="font-mono text-foreground" translate="no">
            .env
          </span>
          . The logo is embedded in the exported file itself, which is why it has
          a size limit and why SVG isn&apos;t accepted: the report has to render
          on a machine with no network, and it must not be able to run anything
          when a client opens it.
        </p>
      </div>
    </section>
  );
}

/** Live indicator for the section, mirroring the other settings panels'. */
function StatusPill({
  loading,
  unreadable,
  configured,
}: {
  loading: boolean;
  unreadable: boolean;
  configured: boolean;
}) {
  if (loading) {
    return (
      <Badge variant="outline" className="gap-1.5 font-mono text-[0.65rem]">
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        CHECKING
      </Badge>
    );
  }
  if (unreadable) {
    return (
      <Badge
        variant="outline"
        className="gap-1.5 border-amber-500/40 font-mono text-[0.65rem] text-amber-400"
      >
        UNAVAILABLE
      </Badge>
    );
  }
  if (configured) {
    return (
      <Badge
        variant="outline"
        className="gap-1.5 border-emerald-500/40 font-mono text-[0.65rem] text-emerald-400"
      >
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-1.5 rounded-full bg-emerald-400" />
        </span>
        IN USE
      </Badge>
    );
  }
  // Not amber: an empty header is a perfectly good configuration, and every
  // other part of the report is unaffected. A neutral statement of fact.
  return (
    <Badge variant="outline" className="gap-1.5 font-mono text-[0.65rem]">
      NO HEADER
    </Badge>
  );
}

/**
 * The block as the client will see it, drawn as a sheet of paper on a mat.
 *
 * Deliberately NOT in app chrome: the whole question this panel answers is
 * "what does the document look like", and a preview wearing the dashboard's
 * own colours answers a different one. A printed report is a light document, so
 * the sheet stays light in both themes and the mat around it carries the theme.
 */
function HeaderPreview({
  branding,
  ready,
}: {
  branding: ReportBranding;
  ready: boolean;
}) {
  // Today's date, formatted once. Only ever RENDERED once `ready` is true —
  // i.e. after the mount fetch — so the server render and the first client
  // render agree and there is nothing for hydration to mismatch on.
  const today = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(new Date()),
    [],
  );

  const hasHeader = Boolean(branding.title || branding.subtitle || branding.logoDataUri);

  return (
    <figure className="m-0 flex flex-col gap-2">
      <figcaption className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground">
        Preview · top of the report
      </figcaption>
      <div className="rounded-md border border-border/60 bg-muted/40 p-4">
        <div className="min-h-28 rounded-sm border border-neutral-300 bg-white px-5 py-4 text-neutral-900 shadow-sm">
          {!ready ? (
            <div className="flex h-20 items-center justify-center font-mono text-[0.65rem] uppercase tracking-[0.2em] text-neutral-400">
              Loading…
            </div>
          ) : hasHeader ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-3">
                {branding.logoDataUri ? (
                  /* eslint-disable-next-line @next/next/no-img-element -- an
                     inline `data:image/…;base64,…` URI: there is nothing to
                     fetch, and next/image would route a base64 blob through the
                     optimizer. The box is sized in CSS because the logo's own
                     pixel dimensions are whatever the user picked. */
                  <img
                    src={branding.logoDataUri}
                    alt="Your report logo"
                    width={128}
                    height={40}
                    className="h-10 w-auto max-w-32 shrink-0 object-contain"
                    decoding="async"
                  />
                ) : null}
                <div className="flex min-w-0 flex-col gap-0.5">
                  {branding.title ? (
                    <p className="truncate text-base leading-tight font-semibold tracking-tight">
                      {branding.title}
                    </p>
                  ) : null}
                  {branding.subtitle ? (
                    <p className="truncate text-xs leading-snug text-neutral-600">
                      {branding.subtitle}
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-neutral-200 pt-2 font-mono text-[0.6rem] uppercase tracking-[0.16em] text-neutral-500">
                <span>Lighthouse audit</span>
                {branding.showDate ? <span>{today}</span> : null}
              </div>
            </div>
          ) : (
            <div className="flex h-20 flex-col items-center justify-center gap-1 text-center">
              <span className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-neutral-400">
                No header block
              </span>
              <span className="text-xs text-neutral-500">
                The report opens with its own masthead instead.
              </span>
            </div>
          )}
        </div>
      </div>
    </figure>
  );
}
