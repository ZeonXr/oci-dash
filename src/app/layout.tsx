import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "OCI Dash",
  description: "现代化 OCI 多账号管理面板",
  icons: { icon: { url: "/oci-logo.png", type: "image/png", sizes: "192x192" } },
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
