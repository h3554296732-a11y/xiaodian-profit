import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { LedgerProvider } from "@/components/ledger-provider";
import { AuthBoundary } from "@/components/auth-screen";
import "./globals.css";
import "./business.css";

export const metadata: Metadata = {
  title: { default: "小店利润本 · 经营概览", template: "%s · 小店利润本" },
  description: "商品、销售与费用记在一起，算清小店每一天的估算经营利润。",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth">
      <body>
        <LedgerProvider>
          <AppShell>
            <AuthBoundary>{children}</AuthBoundary>
          </AppShell>
        </LedgerProvider>
      </body>
    </html>
  );
}
