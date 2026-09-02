import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { ResearchServerSettings } from "@/components/settings/research-server-settings";
import { PsiKeySettings } from "@/components/settings/psi-key-settings";

export const metadata: Metadata = {
  title: "Settings — LightAudit Score",
  description: "Manage API keys and credentials for LightAudit Score's audit engines.",
};

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="06 — Settings"
        title="Settings"
        description="Credentials and integrations for the audit engines. Keys are stored in your operating system's keychain — encrypted at rest and never written to disk in plain text."
      />
      <PsiKeySettings />
      <ResearchServerSettings />
    </div>
  );
}
