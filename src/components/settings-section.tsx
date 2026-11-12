import type { ReactNode } from "react";

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <header>
        <h2 className="text-base font-medium text-ink">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </header>
      {children}
    </section>
  );
}
