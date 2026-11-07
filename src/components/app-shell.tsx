"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Moon,
  Server,
  Settings2,
  Sun,
  ChartNoAxesCombined,
  CircleDollarSign,
} from "lucide-react";
import { useApp } from "./app-provider";
import { Badge, IconButton } from "./ui";
const navigation = [
  { href: "/overview", label: "总览", icon: LayoutDashboard },
  { href: "/instances", label: "实例", icon: Server },
  { href: "/traffic", label: "流量", icon: ChartNoAxesCombined },
  { href: "/costs", label: "成本", icon: CircleDollarSign },
  { href: "/accounts", label: "账号", icon: KeyRound },
  { href: "/tasks", label: "任务", icon: ListChecks },
  { href: "/settings", label: "设置", icon: Settings2 },
];
export function AppShell({ children }: { children: ReactNode }) {
  const { user, demo, theme, setTheme, logout } = useApp();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width:900px)");
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        跳至主要内容
      </a>
      {mobileOpen && (
        <button
          className="sidebar-backdrop"
          onClick={() => setMobileOpen(false)}
          aria-label="关闭导航"
        />
      )}
      <aside
        className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}
        id="primary-navigation"
        aria-label="主导航"
        inert={isMobile && !mobileOpen}
      >
        <Link href="/overview" className="brand">
          <span className="brand-symbol">
            <Server size={21} />
          </span>
          <span>OCI Dash</span>
        </Link>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <Link
              href={item.href}
              key={item.href}
              className={`nav-item ${pathname.startsWith(item.href) ? "active" : ""}`}
              aria-current={pathname.startsWith(item.href) ? "page" : undefined}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile">
            <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{user.username}</strong>
              <span>管理员</span>
            </div>
            <IconButton label="退出登录" onClick={logout}>
              <LogOut size={16} />
            </IconButton>
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <IconButton
            label="展开导航"
            aria-controls="primary-navigation"
            aria-expanded={mobileOpen}
            className="mobile-menu"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={20} />
          </IconButton>
          <div className="topbar-actions">
            {demo && <Badge tone="info">演示环境 · 只读</Badge>}
            <IconButton
              label={theme === "light" ? "切换深色主题" : "切换浅色主题"}
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
            </IconButton>
            <Link href="/settings" className="top-avatar" aria-label="个人设置">
              {user.username.slice(0, 1).toUpperCase()}
            </Link>
          </div>
        </header>
        <main id="main-content" className="page-content">
          {children}
        </main>
      </div>
    </div>
  );
}
