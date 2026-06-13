import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { PsiKeySettings } from "@/components/settings/psi-key-settings";

export const metadata: Metadata = {
  title: "Settings — LightAudit",
  description: "Manage API keys and credentials for LightAudit's audit engines.",
};

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="06 — Settings"
        title="Settings"
        description="Credentials for the audit engines. Keys are stored in your operating system's keychain — encrypted at rest and never written to disk in plain text."
      />
      <PsiKeySettings />
    </div>
  );
}
