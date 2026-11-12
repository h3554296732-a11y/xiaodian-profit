"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLedger } from "./ledger-provider";
import {
  ArrowUpRight,
  BookOpen,
  ChartNoAxesCombined,
  ChevronRight,
  LayoutDashboard,
  Package,
  ReceiptText,
  Store,
  Wallet,
  UserRound,
  X,
  RefreshCw,
  Boxes,
} from "lucide-react";

const navigation = [
  { href: "/", label: "经营概览", icon: LayoutDashboard },
  { href: "/products", label: "商品管理", icon: Package },
  { href: "/inventory", label: "库存与进货", icon: Boxes },
  { href: "/sales", label: "销售记录", icon: ReceiptText },
  { href: "/expenses", label: "经营费用", icon: Wallet },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname().replace(/\/$/, "") || "/";
  const { shopName, user, notice, clearNotice, refresh, ready, busy, loading } =
    useLedger();
  const current =
    navigation.find((item) => item.href === pathname)?.label ??
    (pathname === "/account" ? "店铺与账号" : "使用说明");
  return (
    <>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <Link href="/" className="brand" aria-label="小店利润本首页">
          <span className="brand-mark">
            <ChartNoAxesCombined size={23} />
          </span>
          <span>
            小店利润本<small>每一笔生意，心里有数</small>
          </span>
        </Link>
        <div className="store-switch">
          <span className="store-avatar">
            <Store size={19} />
          </span>
          <span>
            <strong className="max-w-32 truncate">{shopName}</strong>
            <small>{user ? "我的云端店铺" : "请登录"}</small>
          </span>
          <span className="demo-dot" />
        </div>
        <p className="nav-label">我的经营</p>
        <nav aria-label="主要导航" className="desktop-nav">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={pathname === href ? "page" : undefined}
              className={pathname === href ? "nav-item active" : "nav-item"}
            >
              <Icon size={19} />
              <span>{label}</span>
              {pathname === href && <span className="nav-active-dot" />}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="build-note">
            <span className="mini-label">每天给生意留个底</span>
            <strong>收店前，花几分钟记一记</strong>
            <p>
              商品、销售、经营费用，
              <br />
              每一笔都让利润更清楚。
            </p>
            <Link href="/account">
              导出我的账本 <ArrowUpRight size={14} />
            </Link>
          </div>
          <Link
            href="/guide"
            className={pathname === "/guide" ? "nav-item active" : "nav-item"}
          >
            <BookOpen size={19} />
            使用说明
          </Link>
          <Link
            href="/account"
            className={pathname === "/account" ? "nav-item active" : "nav-item"}
          >
            <UserRound size={19} />
            店铺与账号
          </Link>
          <div className="version">
            <span className="demo-dot" /> v1.2.0 · 小店经营账本
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span className="mobile-brand">
              <ChartNoAxesCombined size={20} /> 小店利润本
            </span>
            <span className="desktop-breadcrumb">
              我的店铺 <ChevronRight size={13} /> <strong>{current}</strong>
            </span>
          </div>
          <div className="topbar-right">
            <button
              type="button"
              className="refresh-button"
              onClick={() => void refresh()}
              disabled={!ready || busy || loading}
              aria-label="刷新账本"
            >
              <RefreshCw size={17} className={loading ? "animate-spin" : ""} />
            </button>
            <span className="preview-pill">
              <span />
              {user ? "云端账本" : "请登录"}
            </span>
            <Link href="/account" className="avatar" aria-label="店铺与账号">
              店
            </Link>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {children}
        </main>
        <footer className="app-footer">
          <span>小店利润本 · 把生意记清，把日子过好</span>
          <Link href="/guide#profit-rules">
            估算利润如何计算 <ChevronRight size={13} />
          </Link>
        </footer>
      </div>
      <nav className="mobile-nav" aria-label="手机导航">
        {[
          ...navigation,
          { href: "/account", label: "我的小店", icon: UserRound },
        ].map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={pathname === href ? "page" : undefined}
            className={pathname === href ? "active" : ""}
          >
            <Icon size={20} />
            <span>{href === "/inventory" ? "库存进货" : label}</span>
          </Link>
        ))}
      </nav>
      {notice && (
        <div className="save-toast" role="status">
          <span>{notice}</span>
          <button type="button" aria-label="关闭提示" onClick={clearNotice}>
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}
