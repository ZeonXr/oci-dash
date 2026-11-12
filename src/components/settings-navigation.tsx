"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const sections = [
  { href: "/settings/accounts", label: "OCI 账号" },
  { href: "/settings/security", label: "登录安全" },
  { href: "/settings/general", label: "通用" },
];

export function SettingsNavigation() {
  const pathname = usePathname();
  return (
    <nav
      className="-mt-1 mb-6 flex gap-6 overflow-x-auto border-b border-border"
      aria-label="设置分区"
    >
      {sections.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          className="shrink-0 rounded-sm border-b-2 border-transparent bg-transparent py-3 text-sm whitespace-nowrap text-muted-foreground focus-visible:outline-offset-[-3px] aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-primary"
          aria-current={pathname === href ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
