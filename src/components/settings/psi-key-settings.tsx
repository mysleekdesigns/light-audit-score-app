"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from "react";
import { CheckCircle2, KeyRound, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface KeyState {
  available: boolean;
  set: boolean;
  hint?: string;
  rejected?: boolean;
}

/**
 * PageSpeed Insights API-key management.
 *
 * In the packaged desktop app (`window.lightaudit` present) the key is stored in
 * the OS keychain via the Electron main process; this panel submits/tests/clears
 * it and never sees a stored raw value. Under `next dev` / `next start` the bridge
 * is absent, so the panel falls back to read-only guidance (the key comes from
 * `PAGESPEED_API_KEY` in `.env`). Either way `GET /api/settings/psi-status` tells
 * us whether PSI is currently armed.
 */
export function PsiKeySettings() {
  // Detect the Electron preload bridge without setState-in-effect: a client-only
  // value that's false during SSR and stable after mount (no hydration flash).
  const isDesktop = useSyncExternalStore(
    () => () => {},
    () => typeof window !== "undefined" && Boolean(window.lightaudit?.secrets),
    () => false,
  );
  const [keyState, setKeyState] = useState<KeyState>({ available: false, set: false });
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"idle" | "saving" | "testing" | "clearing">("idle");

  // Pure read — no setState, so it's safe to call synchronously from an effect.
  // Returns the server-side "armed?" truth (env or keychain-injected) plus, in the
  // desktop app, the keychain status (masked hint).
  const fetchStatus = useCallback(async (): Promise<{
    configured: boolean | null;
    key?: KeyState;
  }> => {
    let configured: boolean | null = null;
    try {
      const res = await fetch("/api/settings/psi-status", { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { configured?: boolean };
        configured = Boolean(body.configured);
      }
    } catch {
      configured = null;
    }
    let key: KeyState | undefined;
    if (typeof window !== "undefined" && window.lightaudit?.secrets) {
      key = await window.lightaudit.secrets.status("PAGESPEED_API_KEY");
    }
    return { configured, key };
  }, []);

  // Handler-facing refresh: setState here is fine (runs from event handlers, not
  // an effect).
  const refresh = useCallback(async () => {
    const { configured, key } = await fetchStatus();
    setConfigured(configured);
    if (key) setKeyState(key);
  }, [fetchStatus]);

  // Initial load. The fetch is synchronous-safe (no setState); state is applied in
  // an effect-event via the async `.then`, keeping setState out of reactive effect
  // scope — the codebase's mount-fetch pattern (cf. pagespeed-console).
  const applyStatus = useEffectEvent(
    (data: { configured: boolean | null; key?: KeyState }) => {
      setConfigured(data.configured);
      if (data.key) setKeyState(data.key);
    },
  );
  useEffect(() => {
    let active = true;
    void fetchStatus().then((data) => {
      if (active) applyStatus(data);
    });
    return () => {
      active = false;
    };
  }, [fetchStatus]);

  const handleTest = useCallback(async () => {
    if (!window.lightaudit?.secrets) return;
    setBusy("testing");
    try {
      const result = await window.lightaudit.secrets.test("PAGESPEED_API_KEY", draft);
      if (result.ok) {
        toast.success(result.note ?? "Key validated against PageSpeed Insights.");
      } else {
        toast.error(result.error ?? "The key was rejected by PageSpeed Insights.");
      }
    } finally {
      setBusy("idle");
    }
  }, [draft]);

  const handleSave = useCallback(async () => {
    if (!window.lightaudit?.secrets) return;
    setBusy("saving");
    try {
      const result = await window.lightaudit.secrets.set("PAGESPEED_API_KEY", draft);
      if (result.ok) {
        setDraft("");
        toast.success("Key saved to the OS keychain. PageSpeed audits are ready.");
        await refresh();
      } else {
        toast.error(result.error ?? "Could not save the key.");
      }
    } finally {
      setBusy("idle");
    }
  }, [draft, refresh]);

  const handleClear = useCallback(async () => {
    if (!window.lightaudit?.secrets) return;
    setBusy("clearing");
    try {
      await window.lightaudit.secrets.clear("PAGESPEED_API_KEY");
      toast.success("Key removed from the keychain.");
      await refresh();
    } finally {
      setBusy("idle");
    }
  }, [refresh]);

  const draftValid = draft.trim().length >= 8;

  return (
    <section className="rounded-lg border border-border/60 bg-card/40">
      {/* instrument header strip */}
      <header className="flex items-center justify-between gap-4 border-b border-border/60 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-md border border-border/70 bg-background/60 text-primary">
            <KeyRound className="size-4" aria-hidden="true" />
          </span>
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">
              PageSpeed Insights API key
            </h2>
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
              Google · 25k requests / day
            </span>
          </div>
        </div>
        <StatusPill configured={configured} />
      </header>

      <div className="flex flex-col gap-5 px-5 py-5">
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          PageSpeed audits call Google&apos;s hosted API, which needs your own free
          API key (the keyless quota is effectively zero). Create one in the{" "}
          <a
            href="https://developers.google.com/speed/docs/insights/v5/get-started#APIKey"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            Google Cloud console
          </a>{" "}
          with the <span className="font-mono text-foreground">PageSpeed Insights API</span> enabled, then paste it
          below.
        </p>

        {isDesktop ? (
          <DesktopControls
            keyState={keyState}
            draft={draft}
            setDraft={setDraft}
            draftValid={draftValid}
            busy={busy}
            onTest={handleTest}
            onSave={handleSave}
            onClear={handleClear}
          />
        ) : (
          <BrowserNotice configured={configured} />
        )}
      </div>
    </section>
  );
}

/** Live "armed / not configured" indicator driven by the server status endpoint. */
function StatusPill({ configured }: { configured: boolean | null }) {
  if (configured === null) {
    return (
      <Badge variant="outline" className="gap-1.5 font-mono text-[0.65rem]">
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        CHECKING
      </Badge>
    );
  }
  return configured ? (
    <Badge
      variant="outline"
      className="gap-1.5 border-emerald-500/40 font-mono text-[0.65rem] text-emerald-400"
    >
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex size-1.5 rounded-full bg-emerald-400" />
      </span>
      READY
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="gap-1.5 border-amber-500/40 font-mono text-[0.65rem] text-amber-400"
    >
      NOT CONFIGURED
    </Badge>
  );
}

interface DesktopControlsProps {
  keyState: KeyState;
  draft: string;
  setDraft: (v: string) => void;
  draftValid: boolean;
  busy: "idle" | "saving" | "testing" | "clearing";
  onTest: () => void;
  onSave: () => void;
  onClear: () => void;
}

function DesktopControls({
  keyState,
  draft,
  setDraft,
  draftValid,
  busy,
  onTest,
  onSave,
  onClear,
}: DesktopControlsProps) {
  const working = busy !== "idle";

  if (!keyState.available) {
    return (
      <div className="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <XCircle className="mt-0.5 size-4 shrink-0 text-amber-400" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          {keyState.rejected
            ? "The app refused this key-manager request, so its status can't be read. Reopen Settings from the app window; if it persists, restart LightAudit."
            : "The operating system's secure storage (keychain) is unavailable on this machine, so the key can't be stored safely. PageSpeed audits will stay disabled until secure storage is enabled."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {keyState.set ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/60 bg-background/50 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="size-4 text-emerald-400" aria-hidden="true" />
            <span className="text-sm text-foreground">A key is stored in the keychain</span>
            {keyState.hint ? (
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                {keyState.hint}
              </code>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={working}
            className="text-destructive hover:text-destructive"
          >
            {busy === "clearing" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            Remove key
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label
          htmlFor="psi-key"
          className="font-mono text-[0.7rem] uppercase tracking-[0.2em] text-muted-foreground"
        >
          {keyState.set ? "Replace key" : "Enter key"}
        </Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="psi-key"
            type="password"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="AIza…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={working}
            className="font-mono"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onTest}
              disabled={working || !draftValid}
            >
              {busy === "testing" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="size-3.5" aria-hidden="true" />
              )}
              Test
            </Button>
            <Button type="button" onClick={onSave} disabled={working || !draftValid}>
              {busy === "saving" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              Save
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The key is encrypted with the OS keychain and never written to disk in
          plain text. Saving restarts the local audit server so it takes effect
          immediately.
        </p>
      </div>
    </div>
  );
}

/** Read-only guidance when running in a plain browser (dev), where the key comes from .env. */
function BrowserNotice({ configured }: { configured: boolean | null }) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-md border px-4 py-3",
        configured
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-border/60 bg-background/50"
      )}
    >
      {configured ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" aria-hidden="true" />
      ) : (
        <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <div className="flex flex-col gap-1 text-sm text-muted-foreground">
        <span>
          {configured
            ? "A PageSpeed Insights key is active from the environment."
            : "No PageSpeed Insights key is configured."}
        </span>
        <span>
          You&apos;re running in a browser dev session. Set{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
            PAGESPEED_API_KEY
          </code>{" "}
          in your <span className="font-mono text-foreground">.env</span> file. In
          the packaged desktop app, the key is managed here and stored in the OS
          keychain.
        </span>
      </div>
    </div>
  );
}
