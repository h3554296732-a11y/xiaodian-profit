"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  Download,
  ShieldCheck,
  Store,
  Wallet,
} from "lucide-react";
import { useLedger } from "./ledger-provider";
import { friendlyError, getSupabase } from "@/lib/supabase";
import { phoneAuthEnabled } from "@/lib/phone-auth";
import { PhoneAuth } from "./phone-auth";

export function AuthBoundary({ children }: { children: ReactNode }) {
  const {
    ready,
    authReady,
    loading,
    error,
    user,
    shop,
    refresh,
    recovery,
    recoveryUserId,
  } = useLedger();
  const pathname = usePathname().replace(/\/$/, "") || "/";
  if (pathname === "/guide" || pathname === "/privacy") return children;
  if (authReady && recovery && user?.id === recoveryUserId)
    return <PasswordRecovery />;
  if (loading || !ready)
    return (
      <div className="panel py-20 text-center text-stone-500" role="status">
        正在打开你的账本…
      </div>
    );
  if (error)
    return (
      <div className="panel mx-auto max-w-xl py-12">
        <h1 className="text-xl font-semibold">账本暂时没有成功加载</h1>
        <p role="alert" className="my-5 leading-7 text-red-800">
          {error}
        </p>
        <button
          className="button button-primary"
          onClick={() => void refresh()}
        >
          重新加载
        </button>
        <CloudRecoveryActions />
        <p className="mt-5 text-sm text-stone-500">
          我们不会用空账本覆盖已经保存的数据。
        </p>
      </div>
    );
  if (!user) return <AuthScreen />;
  if (!shop) return <ShopSetup />;
  return children;
}

function CloudRecoveryActions() {
  const { signOut } = useLedger();
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState(false);
  async function leaveCloud() {
    setPending(true);
    setActionError("");
    try {
      await signOut();
    } catch (cause) {
      setActionError(friendlyError(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="mt-4 flex flex-wrap gap-3">
      <button
        className="button button-secondary"
        disabled={pending}
        onClick={() => void leaveCloud()}
      >
        退出当前账号
      </button>
      {actionError && (
        <p role="alert" className="w-full text-red-800">
          {actionError}
        </p>
      )}
    </div>
  );
}

export function AuthScreen() {
  const { cloudConfigured, finishRecovery } = useLedger();
  const [method, setMethod] = useState<"email" | "phone">("email");
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [tab, setTab] = useState<"login" | "register" | "forgot">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    const client = getSupabase();
    if (!client) {
      setError("账号服务尚未配置完成，请稍后重试或联系网站管理员。");
      return;
    }
    if (
      tab === "register" &&
      (password.length < 10 ||
        !/[A-Za-z]/.test(password) ||
        !/\d/.test(password))
    ) {
      setError("密码请至少填写 10 位，并包含字母和数字。");
      return;
    }
    if (tab === "register" && password !== confirm) {
      setError("两次密码不一致。");
      return;
    }
    if (tab === "register" && !accepted) {
      setError("请先阅读并同意使用与隐私说明。");
      return;
    }
    setBusy(true);
    try {
      const origin = window.location.origin;
      if (tab === "login") {
        const { error: cause } = await client.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (cause) throw cause;
        setPassword("");
        finishRecovery();
      } else if (tab === "register") {
        const { data, error: cause } = await client.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: `${origin}/account/` },
        });
        if (cause) throw cause;
        setPassword("");
        setConfirm("");
        if (!data.session)
          setMessage(
            "如果该邮箱可以注册，我们已发送确认邮件。请查收邮件后返回登录；也可以查看垃圾邮件文件夹。",
          );
      } else {
        const { error: cause } = await client.auth.resetPasswordForEmail(
          email.trim(),
          { redirectTo: `${origin}/account/` },
        );
        if (cause) throw cause;
        setMessage(
          "如果该邮箱已注册，我们会发送密码重置邮件。请查收，并从邮件链接打开本网站。",
        );
      }
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="auth-grid">
      <div className="auth-intro">
        <span className="inline-flex rounded-xl bg-white/10 p-3">
          <Wallet size={25} />
        </span>
        <p className="mt-8 text-sm text-emerald-100">为认真经营的小店而做</p>
        <h1 className="mt-3 text-3xl font-semibold leading-relaxed text-white">
          生意忙得过来，
          <br />
          账也算得明白。
        </h1>
        <p className="mt-5 leading-8 text-emerald-100">
          商品、销售和费用放在一本账里，
          <br />
          每天花几分钟，看见每一分辛苦。
        </p>
        <ul className="mt-8 space-y-4 text-sm text-emerald-50">
          {[
            "实际售价与成本留下历史快照",
            "今日、本周、本月的估算经营利润",
            "每位店主只看自己的经营数据",
          ].map((text) => (
            <li className="flex items-center gap-3" key={text}>
              <Check size={17} />
              {text}
            </li>
          ))}
        </ul>
      </div>
      <div className="panel auth-form">
        <span className="eyebrow">小店利润本</span>
        <h2 className="mt-3 text-2xl font-semibold">
          {method === "phone"
            ? "手机号登录 / 注册"
            : tab === "register"
              ? "给小店开一本新账"
              : tab === "forgot"
                ? "找回登录密码"
                : "欢迎回到你的小店"}
        </h2>
        <p className="mt-3 text-sm leading-7 text-stone-500">
          {cloudConfigured
            ? method === "phone"
              ? "使用短信验证码进入你的小店账本。"
              : "使用邮箱登录，账本跟着账号走。"
            : "账号服务正在配置，请稍后重试或联系网站管理员。"}
        </p>
        {phoneAuthEnabled && cloudConfigured && (
          <div
            className="mt-6 flex rounded-xl bg-stone-100 p-1"
            aria-label="登录方式"
          >
            {(["email", "phone"] as const).map((value) => (
              <button
                type="button"
                key={value}
                disabled={busy || phoneBusy}
                aria-pressed={method === value}
                className={`min-h-11 flex-1 rounded-lg text-sm ${method === value ? "bg-white font-medium text-emerald-900 shadow-sm" : "text-stone-500"}`}
                onClick={() => {
                  setMethod(value);
                  setTab("login");
                  setPassword("");
                  setConfirm("");
                  setAccepted(false);
                  setError("");
                  setMessage("");
                }}
              >
                {value === "email" ? "邮箱" : "手机号"}
              </button>
            ))}
          </div>
        )}
        {method === "phone" ? (
          <PhoneAuth onBusyChange={setPhoneBusy} />
        ) : (
          <>
            <div className="my-6 flex gap-6 border-b border-stone-100">
              {(["login", "register"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setTab(value);
                    setError("");
                    setMessage("");
                  }}
                  className={`min-h-11 border-b-2 pb-3 text-sm ${tab === value ? "border-emerald-800 text-emerald-900" : "border-transparent text-stone-500"}`}
                >
                  {value === "login" ? "登录" : "注册"}
                </button>
              ))}
            </div>
            <form className="space-y-5" onSubmit={submit}>
              <label className="field">
                邮箱
                <input
                  autoComplete="email"
                  type="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="你的常用邮箱"
                />
              </label>
              {tab !== "forgot" && (
                <label className="field">
                  密码
                  <input
                    type="password"
                    autoComplete={
                      tab === "register" ? "new-password" : "current-password"
                    }
                    required
                    minLength={tab === "register" ? 10 : 1}
                    maxLength={128}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={
                      tab === "register"
                        ? "至少10位，包含字母和数字"
                        : "输入登录密码"
                    }
                  />
                </label>
              )}
              {tab === "register" && (
                <>
                  <label className="field">
                    确认密码
                    <input
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={10}
                      maxLength={128}
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      placeholder="再次输入密码"
                    />
                  </label>
                  <label className="flex items-start gap-3 text-xs leading-6 text-stone-600">
                    <input
                      type="checkbox"
                      required
                      checked={accepted}
                      onChange={(e) => setAccepted(e.target.checked)}
                      className="mt-1 size-4 accent-emerald-800"
                    />
                    <span>
                      我已阅读并同意
                      <Link
                        href="/privacy"
                        target="_blank"
                        className="text-emerald-800 underline"
                      >
                        使用与隐私说明
                      </Link>
                      ，了解结果属于估算经营利润。
                    </span>
                  </label>
                </>
              )}
              {error && (
                <p
                  role="alert"
                  className="rounded-lg bg-red-50 p-3 text-sm leading-6 text-red-800"
                >
                  {error}
                </p>
              )}
              {message && (
                <p
                  role="status"
                  className="rounded-lg bg-emerald-50 p-3 text-sm leading-7 text-emerald-900"
                >
                  {message}
                </p>
              )}
              <button
                className="button button-primary w-full"
                disabled={busy || !cloudConfigured}
              >
                {busy
                  ? "请稍候…"
                  : tab === "register"
                    ? "注册账号"
                    : tab === "forgot"
                      ? "发送重置邮件"
                      : "登录我的账本"}
                <ArrowRight size={16} />
              </button>
            </form>
            {tab === "login" && (
              <button
                type="button"
                disabled={busy}
                className="mt-3 min-h-11 text-xs text-stone-500"
                onClick={() => {
                  setTab("forgot");
                  setError("");
                  setMessage("");
                }}
              >
                忘记密码？
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ShopSetup() {
  const { createMyShop, busy, signOut } = useLedger();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  return (
    <section className="panel mx-auto max-w-xl py-10">
      <Store className="mb-5 text-emerald-800" size={30} />
      <h1 className="text-2xl font-semibold">先给你的小店起个名字</h1>
      <p className="mt-3 text-sm leading-7 text-stone-500">
        一个账号管理一家店，建立后就可以添加商品了。
      </p>
      <form
        className="mt-7 space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await createMyShop(name);
          } catch (cause) {
            setError(friendlyError(cause));
          }
        }}
      >
        <label className="field">
          店铺名称
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：街角便利店"
            autoFocus
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-800">
            {error}
          </p>
        )}
        <button className="button button-primary" disabled={busy}>
          {busy ? "正在创建…" : "创建我的店铺"}
        </button>
      </form>
      <button
        className="mt-5 min-h-11 text-sm text-stone-500"
        onClick={() =>
          void signOut().catch((cause) => setError(friendlyError(cause)))
        }
      >
        退出账号
      </button>
    </section>
  );
}

function PasswordRecovery() {
  const {
    finishRecovery,
    saveRecoveryPassword,
    recoveryUserId,
    recoveryEmail,
  } = useLedger();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (
      password !== confirm ||
      password.length < 10 ||
      !/[A-Za-z]/.test(password) ||
      !/\d/.test(password)
    ) {
      setError("请填写至少10位、包含字母与数字且两次一致的新密码。");
      return;
    }
    setBusy(true);
    try {
      if (!recoveryUserId) throw new Error("请重新申请密码重置邮件。");
      await saveRecoveryPassword(password, recoveryUserId);
      setPassword("");
      setConfirm("");
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel mx-auto max-w-lg">
      <h1 className="text-2xl font-semibold">设置新的登录密码</h1>
      <p className="mt-4 break-all text-sm leading-7 text-stone-600">
        正在为 {recoveryEmail ?? "当前邮箱账号"} 设置新密码，请确认邮箱无误。
      </p>
      <form className="mt-7 space-y-5" onSubmit={save}>
        <label className="field">
          新密码
          <input
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={128}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="field">
          确认新密码
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-800">
            {error}
          </p>
        )}
        <button disabled={busy} className="button button-primary">
          {busy ? "保存中…" : "保存新密码"}
        </button>
      </form>
      <button
        type="button"
        disabled={busy}
        className="mt-4 min-h-11 text-sm text-stone-500"
        onClick={finishRecovery}
      >
        取消重置
      </button>
    </section>
  );
}

export function AccountScreen() {
  const { data, shopName, user, signOut, renameShop, busy } = useLedger();
  const [name, setName] = useState(shopName);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  function download() {
    const text = JSON.stringify(
      {
        schemaVersion: 2,
        unitCostScale: 1000,
        exportedAt: new Date().toISOString(),
        shopName,
        currency: "CNY",
        timezone: "Asia/Shanghai",
        data,
      },
      null,
      2,
    );
    const url = URL.createObjectURL(
      new Blob([text], { type: "application/json;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `小店利润本_账本备份_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="space-y-6">
      <div className="page-heading">
        <div>
          <p className="eyebrow">我的小店</p>
          <h1>店铺与账号</h1>
          <p className="muted">店名、登录与账本备份，都在这里。</p>
        </div>
      </div>
      <section className="panel max-w-2xl">
        <h2 className="flex items-center gap-2 font-semibold">
          <Store size={19} />
          店铺信息
        </h2>
        <form
          className="mt-6 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            setSaving(true);
            try {
              await renameShop(name);
            } catch (cause) {
              setError(friendlyError(cause));
            } finally {
              setSaving(false);
            }
          }}
        >
          <label className="field">
            店铺名称
            <input
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <p className="text-xs leading-6 text-stone-500">
            人民币 CNY · 上海时区 · 每周从周一开始
          </p>
          {error && (
            <p role="alert" className="text-sm text-red-800">
              {error}
            </p>
          )}
          <button className="button button-primary" disabled={saving || busy}>
            {saving ? "保存中…" : "保存店名"}
          </button>
        </form>
      </section>
      <section className="panel max-w-2xl">
        <h2 className="flex items-center gap-2 font-semibold">
          <ShieldCheck size={19} />
          云端账号
        </h2>
        <p className="mt-4 text-sm leading-7 text-stone-600">
          {`已登录：${user?.email || user?.phone || "你的账号"}。经营数据保存到你的云端店铺，其他商户无法访问。`}
        </p>
        <button
          className="button button-secondary mt-5"
          onClick={() =>
            void signOut().catch((cause) => setError(friendlyError(cause)))
          }
        >
          退出登录
        </button>
      </section>
      <section className="panel max-w-2xl">
        <h2 className="font-semibold">留一份账本备份</h2>
        <p className="mt-3 text-sm leading-7 text-stone-500">
          导出包含商品、销售快照和费用的 JSON
          文件，请妥善保管。备份不会发送给其他人。
        </p>
        <button className="button button-secondary mt-5" onClick={download}>
          <Download size={16} />
          导出我的账本
        </button>
      </section>
      <p className="text-xs text-stone-500">
        <Link href="/privacy" className="text-emerald-800 underline">
          使用与隐私说明
        </Link>{" "}
        · v1.2.0
      </p>
    </div>
  );
}
