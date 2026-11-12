"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChartNoAxesCombined,
  CircleDollarSign,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Moon,
  Server,
  Settings2,
  Sun,
  X,
} from "lucide-react";
import { useApp } from "./app-provider";
import { IconButton } from "./ui";
import { Button as NavigationButton } from "./ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "./ui/sheet";

const navigation = [
  { href: "/overview", label: "总览", icon: LayoutDashboard },
  { href: "/instances", label: "实例", icon: Server },
  { href: "/traffic", label: "流量", icon: ChartNoAxesCombined },
  { href: "/costs", label: "成本", icon: CircleDollarSign },
  { href: "/tasks", label: "任务", icon: ListChecks },
];

function NavigationContent({ onNavigate }: { onNavigate: () => void }) {
  const { user, theme, setTheme, logout } = useApp();
  const pathname = usePathname();
  return (
    <>
      <Link
        href="/overview"
        className="brand flex items-center gap-2.5 text-lg leading-7 font-semibold tracking-tight text-ink"
        onClick={onNavigate}
      >
        <img
          className="size-8 shrink-0 object-contain"
          src="/oci-logo.png"
          alt=""
          width={32}
          height={32}
        />
        <span>OCI Dash</span>
      </Link>
      <nav className="flex flex-col gap-1" aria-label="主导航">
        {navigation.map((item) => (
          <Link
            href={item.href}
            key={item.href}
            className="flex min-h-10 items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-foreground hover:bg-surface-hover hover:text-ink aria-[current=page]:bg-soft aria-[current=page]:text-primary"
            aria-current={pathname.startsWith(item.href) ? "page" : undefined}
            onClick={onNavigate}
          >
            <item.icon size={18} />
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>
      <div className="mt-auto pt-6">
        <div className="mb-2 flex items-center gap-3">
          <Link
            href="/settings"
            className="sidebar-settings flex min-h-9 flex-1 items-center gap-3 rounded-md px-3 py-2 text-xs font-medium hover:bg-surface-hover hover:text-ink aria-[current=page]:bg-soft aria-[current=page]:text-primary"
            aria-current={pathname.startsWith("/settings") ? "page" : undefined}
            onClick={onNavigate}
          >
            <Settings2 size={18} />
            <span>设置</span>
          </Link>
          <IconButton
            label={theme === "light" ? "切换深色主题" : "切换浅色主题"}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
          </IconButton>
        </div>
        <div className="flex h-12 items-center gap-2.5 border-t border-border">
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-soft text-xs text-primary">
            {user.username.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <strong className="block truncate text-xs font-medium">{user.username}</strong>
          </div>
          <IconButton
            label="退出登录"
            onClick={() => {
              onNavigate();
              void logout();
            }}
          >
            <LogOut size={16} />
          </IconButton>
        </div>
      </div>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const desktopNavigation = useRef<HTMLElement>(null);

  useEffect(() => {
    const query = window.matchMedia("(min-width:901px)");
    const closeDesktopSheet = () => {
      if (query.matches) setMobileOpen(false);
    };
    closeDesktopSheet();
    query.addEventListener("change", closeDesktopSheet);
    return () => query.removeEventListener("change", closeDesktopSheet);
  }, []);
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main-content"
        className="fixed -top-16 left-60 z-100 rounded-md bg-primary px-4 py-2.5 text-primary-foreground focus:top-2.5 max-[900px]:left-5 max-[620px]:left-4"
      >
        跳至主要内容
      </a>
      <aside
        ref={desktopNavigation}
        className="sidebar fixed inset-y-0 left-0 z-40 flex w-52 flex-col gap-6 overflow-y-auto border-r border-border bg-surface p-5 max-[900px]:hidden"
        id="primary-navigation"
        aria-label="主导航"
      >
        <NavigationContent onNavigate={() => setMobileOpen(false)} />
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetTrigger asChild>
          <NavigationButton
            variant="outline"
            size="icon"
            className="absolute top-4 left-5 z-30 hidden max-[900px]:inline-flex max-[620px]:left-4"
            aria-label="展开导航"
            title="展开导航"
          >
            <Menu size={20} aria-hidden="true" />
          </NavigationButton>
        </SheetTrigger>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="gap-6 overflow-y-auto p-5 data-[side=left]:w-72 data-[side=left]:sm:max-w-72"
          onCloseAutoFocus={(event) => {
            if (!window.matchMedia("(min-width:901px)").matches) return;
            event.preventDefault();
            desktopNavigation.current
              ?.querySelector<HTMLElement>('a[aria-current="page"]')
              ?.focus({ preventScroll: true });
          }}
        >
          <SheetTitle className="sr-only">主导航</SheetTitle>
          <SheetDescription className="sr-only">选择页面，切换主题或退出登录。</SheetDescription>
          <SheetClose asChild>
            <NavigationButton
              variant="ghost"
              size="icon-sm"
              className="absolute top-3 right-3"
              aria-label="关闭导航"
            >
              <X size={18} aria-hidden="true" />
            </NavigationButton>
          </SheetClose>
          <NavigationContent onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="ml-52 flex min-h-dvh w-[calc(100%-13rem)] flex-col max-[900px]:ml-0 max-[900px]:w-full">
        <main
          id="main-content"
          className="mx-auto w-full max-w-[1730px] flex-1 px-8 pt-8 pb-6 min-[1600px]:pt-9 max-[1180px]:px-6 max-[1180px]:pt-6 max-[900px]:px-5 max-[900px]:pt-16 max-[620px]:px-4"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
