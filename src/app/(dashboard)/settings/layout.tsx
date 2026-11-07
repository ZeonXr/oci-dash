import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui";
import { SettingsNavigation } from "@/components/settings-navigation";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="settings-layout">
      <PageHeader title="设置" />
      <SettingsNavigation />
      {children}
    </div>
  );
}
