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
    <nav className="tabs settings-tabs" aria-label="设置分区">
      {sections.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          className={pathname === href ? "active" : undefined}
          aria-current={pathname === href ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
