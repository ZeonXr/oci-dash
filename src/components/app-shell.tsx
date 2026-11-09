"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Moon,
  Server,
  Settings2,
  Sun,
  X,
  ChartNoAxesCombined,
  CircleDollarSign,
} from "lucide-react";
import { useApp } from "./app-provider";
import { IconButton } from "./ui";
const navigation = [
  { href: "/overview", label: "总览", icon: LayoutDashboard },
  { href: "/instances", label: "实例", icon: Server },
  { href: "/traffic", label: "流量", icon: ChartNoAxesCombined },
  { href: "/costs", label: "成本", icon: CircleDollarSign },
  { href: "/tasks", label: "任务", icon: ListChecks },
];
export function AppShell({ children }: { children: ReactNode }) {
  const { user, theme, setTheme, logout } = useApp();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const query = window.matchMedia("(max-width:900px)");
    const update = () => {
      setIsMobile(query.matches);
      if (!query.matches) setMobileOpen(false);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!isMobile || !mobileOpen) return;
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const previousOverflow = document.body.style.overflow;
    const notifications = document.querySelector<HTMLElement>(".toast-stack");
    const notificationsWereInert = notifications?.inert ?? false;
    document.body.style.overflow = "hidden";
    if (notifications) notifications.inert = true;
    sidebar.querySelector<HTMLButtonElement>(".mobile-navigation-close")?.focus();
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !sidebar.contains(event.target)) {
        sidebar.querySelector<HTMLButtonElement>(".mobile-navigation-close")?.focus();
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        sidebar.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]'),
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", key);
    document.addEventListener("focusin", containFocus);
    return () => {
      window.removeEventListener("keydown", key);
      document.removeEventListener("focusin", containFocus);
      document.body.style.overflow = previousOverflow;
      if (notifications) notifications.inert = notificationsWereInert;
      if (window.matchMedia("(max-width:900px)").matches) {
        menuButtonRef.current?.focus({ preventScroll: true });
      } else {
        sidebar
          .querySelector<HTMLElement>('a[aria-current="page"]')
          ?.focus({ preventScroll: true });
      }
    };
  }, [isMobile, mobileOpen]);
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link" inert={isMobile && mobileOpen}>
        跳至主要内容
      </a>
      <button
        ref={menuButtonRef}
        type="button"
        aria-label="展开导航"
        title="展开导航"
        aria-controls="primary-navigation"
        aria-expanded={mobileOpen}
        tabIndex={mobileOpen ? -1 : undefined}
        className="button button-ghost icon-button mobile-menu"
        onClick={() => setMobileOpen(true)}
      >
        <Menu size={20} aria-hidden="true" />
      </button>
      {isMobile && mobileOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          onClick={() => setMobileOpen(false)}
          aria-label="关闭导航遮罩"
          tabIndex={-1}
        />
      )}
      <aside
        ref={sidebarRef}
        className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}
        id="primary-navigation"
        aria-label="主导航"
        role={isMobile && mobileOpen ? "dialog" : undefined}
        aria-modal={isMobile && mobileOpen ? true : undefined}
        inert={isMobile && !mobileOpen}
      >
        <Link href="/overview" className="brand" onClick={() => setMobileOpen(false)}>
          <img className="brand-symbol" src="/oci-logo.png" alt="" width={32} height={32} />
          <span>OCI Dash</span>
        </Link>
        <IconButton
          label="关闭导航"
          className="mobile-navigation-close"
          onClick={() => setMobileOpen(false)}
        >
          <X size={18} />
        </IconButton>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <Link
              href={item.href}
              key={item.href}
              className={`nav-item ${pathname.startsWith(item.href) ? "active" : ""}`}
              aria-current={pathname.startsWith(item.href) ? "page" : undefined}
              onClick={() => setMobileOpen(false)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-controls">
            <Link
              href="/settings"
              className={`sidebar-settings ${pathname.startsWith("/settings") ? "active" : ""}`}
              aria-current={pathname.startsWith("/settings") ? "page" : undefined}
              onClick={() => setMobileOpen(false)}
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
          <div className="profile">
            <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{user.username}</strong>
            </div>
            <IconButton
              label="退出登录"
              onClick={() => {
                setMobileOpen(false);
                void logout();
              }}
            >
              <LogOut size={16} />
            </IconButton>
          </div>
        </div>
      </aside>
      <div className="app-main" inert={isMobile && mobileOpen}>
        <main id="main-content" className="page-content">
          {children}
        </main>
      </div>
    </div>
  );
}
