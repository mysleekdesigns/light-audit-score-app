import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { AiProviderSettings } from "@/components/settings/ai-provider-settings";
import { ResearchServerSettings } from "@/components/settings/research-server-settings";
import { PsiKeySettings } from "@/components/settings/psi-key-settings";

export const metadata: Metadata = {
  title: "Settings — LightAudit Score",
  description: "API keys and integrations for LightAudit Score's audit engines.",
};

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        kicker="06 — Settings"
        title="Settings"
        description="Credentials and integrations for the audit engines. LightAudit Score reads these from your environment — normally a gitignored .env file in the project root."
      />
      <PsiKeySettings />
      <AiProviderSettings />
      <ResearchServerSettings />
    </div>
  );
}
