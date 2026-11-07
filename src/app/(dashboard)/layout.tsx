import type { ReactNode } from "react";
import { AppProvider } from "@/components/app-provider";
import { AppShell } from "@/components/app-shell";
export default function DashboardLayout({children}:{children:ReactNode}) { return <AppProvider><AppShell>{children}</AppShell></AppProvider>; }
