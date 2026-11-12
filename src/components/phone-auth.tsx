"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getSupabase } from "@/lib/supabase";
import {
  acceptPhoneVerification,
  createPhoneOtpTransport,
  normalizeMainlandPhone,
  phoneAuthError,
  requestPhoneCode,
  resendSeconds,
} from "@/lib/phone-auth";

// Only resend deadlines survive switching tabs in this page. No OTP is retained.
const resendDeadlines = new Map<string, number>();

export function PhoneAuth({
  onBusyChange,
}: {
  onBusyChange: (busy: boolean) => void;
}) {
  const [phone, setPhone] = useState("");
  const [sentPhone, setSentPhone] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);
  const [error, setError] = useState("");
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const phoneRef = useRef(phone);
  const transport = useMemo(() => createPhoneOtpTransport(), []);
  const remaining = resendSeconds(deadline, now);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      pending.current = false;
      onBusyChange(false);
    };
  }, [onBusyChange]);

  useEffect(() => {
    if (!deadline) return;
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 1000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [deadline]);

  function begin(kind: "send" | "verify", normalized: string) {
    if (pending.current) return null;
    const input = phoneRef.current;
    if (normalizeMainlandPhone(input) !== normalized) return null;
    pending.current = true;
    const revision = ++generation.current;
    setBusy(kind);
    onBusyChange(true);
    return {
      isCurrent: () =>
        mounted.current &&
        generation.current === revision &&
        phoneRef.current === input,
      finish: () => {
        if (!mounted.current || generation.current !== revision) return;
        pending.current = false;
        setBusy(null);
        onBusyChange(false);
      },
    };
  }

  async function send() {
    if (pending.current) return;
    setError("");
    setToken("");
    let normalized: string;
    try {
      normalized = normalizeMainlandPhone(phoneRef.current);
    } catch (cause) {
      setError(phoneAuthError(cause));
      return;
    }
    const attempt = begin("send", normalized);
    if (!attempt) return;
    try {
      const result = await requestPhoneCode({
        transport,
        phone: normalized,
        accepted,
        resendAt: resendDeadlines.get(normalized) ?? 0,
        isCurrent: attempt.isCurrent,
      });
      if (!result) return;
      resendDeadlines.set(normalized, result.resendAt);
      setDeadline(result.resendAt);
      setNow(Date.now());
      setSentPhone(result.phone);
    } catch (cause) {
      if (attempt.isCurrent()) setError(phoneAuthError(cause));
    } finally {
      attempt.finish();
    }
  }

  async function verify() {
    if (pending.current || !sentPhone) return;
    setError("");
    const client = getSupabase();
    if (!client) {
      setError("账号服务尚未配置完成，请稍后重试。");
      return;
    }
    const attempt = begin("verify", sentPhone);
    if (!attempt) return;
    try {
      await acceptPhoneVerification({
        transport,
        phone: sentPhone,
        token,
        isCurrent: attempt.isCurrent,
        getCurrentSession: async () => {
          const { data, error: cause } = await client.auth.getSession();
          if (cause) throw cause;
          return data.session;
        },
        setSession: async (session) => {
          const { error: cause } = await client.auth.setSession(session);
          if (cause) throw cause;
        },
      });
    } catch (cause) {
      if (attempt.isCurrent()) {
        setToken("");
        setError(phoneAuthError(cause));
      }
    } finally {
      attempt.finish();
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (sentPhone) void verify();
    else void send();
  }

  return (
    <form className="mt-6 space-y-5" onSubmit={submit}>
      <p className="text-sm leading-7 text-stone-600">
        已有邮箱账本请继续用邮箱登录。手机号注册的账号不会自动合并原账本。
      </p>
      {sentPhone ? (
        <>
          <p className="text-sm leading-7 text-stone-600" role="status">
            验证码已发送至 <strong>{sentPhone}</strong>
          </p>
          <button
            type="button"
            disabled={busy !== null}
            className="min-h-11 text-sm text-emerald-800 underline"
            onClick={() => {
              generation.current += 1;
              setSentPhone(null);
              setToken("");
              setError("");
            }}
          >
            修改手机号
          </button>
          <label className="field">
            短信验证码
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              disabled={busy !== null}
              value={token}
              onChange={(event) =>
                setToken(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
              placeholder="输入 6 位验证码"
            />
          </label>
          <button
            type="button"
            disabled={busy !== null || remaining > 0}
            className="min-h-11 text-sm text-emerald-800 disabled:text-stone-400"
            onClick={() => void send()}
          >
            {remaining > 0 ? `${remaining} 秒后可重新获取` : "重新获取验证码"}
          </button>
        </>
      ) : (
        <>
          <label className="field">
            中国大陆手机号
            <div className="flex items-center gap-3">
              <span className="text-sm text-stone-600">+86</span>
              <input
                className="min-w-0 flex-1"
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                maxLength={24}
                required
                disabled={busy !== null}
                value={phone}
                onChange={(event) => {
                  const value = event.target.value;
                  phoneRef.current = value;
                  generation.current += 1;
                  setPhone(value);
                  setToken("");
                  setError("");
                  try {
                    setDeadline(
                      resendDeadlines.get(normalizeMainlandPhone(value)) ?? 0,
                    );
                  } catch {
                    setDeadline(0);
                  }
                  setNow(Date.now());
                }}
                placeholder="11 位手机号"
              />
            </div>
          </label>
          <label className="flex items-start gap-3 text-xs leading-6 text-stone-600">
            <input
              type="checkbox"
              required
              checked={accepted}
              disabled={busy !== null}
              onChange={(event) => setAccepted(event.target.checked)}
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
              。未注册的手机号将创建新账号。
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
      <button
        className="button button-primary w-full"
        disabled={busy !== null || (!sentPhone && remaining > 0)}
      >
        {busy === "send"
          ? "正在发送…"
          : busy === "verify"
            ? "正在验证…"
            : sentPhone
              ? "验证并登录"
              : remaining > 0
                ? `${remaining} 秒后可获取`
                : "获取验证码"}
        <ArrowRight size={16} />
      </button>
    </form>
  );
}
