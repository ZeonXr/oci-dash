"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { tabsListVariants, tabsTriggerClassName } from "@/components/ui/tabs";

const sections = [
  { href: "/settings/accounts", label: "OCI 账号" },
  { href: "/settings/security", label: "登录安全" },
  { href: "/settings/general", label: "通用" },
];

export function SettingsNavigation() {
  const pathname = usePathname();
  return (
    <nav
      className="group/tabs mb-6 min-w-0 overflow-x-auto overflow-y-hidden pb-1"
      data-orientation="horizontal"
      aria-label="设置分区"
    >
      <div data-variant="line" className={cn(tabsListVariants({ variant: "line" }), "gap-4")}>
        {sections.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className={cn(tabsTriggerClassName, "shrink-0 px-2")}
            data-active={pathname === href || undefined}
            aria-current={pathname === href ? "page" : undefined}
            onFocus={(event) =>
              event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })
            }
          >
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
