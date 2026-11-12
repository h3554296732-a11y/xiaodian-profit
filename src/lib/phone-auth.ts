import { createClient, type Session } from "@supabase/supabase-js";

export const phoneAuthEnabled =
  process.env.NEXT_PUBLIC_PHONE_AUTH_ENABLED === "true";
export const PHONE_RESEND_MS = 60_000;

export function normalizeMainlandPhone(input: string): string {
  let local = input.trim().replace(/[\s()-]/g, "");
  if (local.startsWith("+86")) local = local.slice(3);
  else if (local.startsWith("0086")) local = local.slice(4);
  else if (/^86\d{11}$/.test(local)) local = local.slice(2);
  if (!/^1[3-9]\d{9}$/.test(local))
    throw new Error("请填写 11 位中国大陆手机号。");
  return `+86${local}`;
}

export function validatePhoneOtp(input: string): string {
  const token = input.trim();
  if (!/^\d{6}$/.test(token)) throw new Error("请填写短信中的 6 位验证码。");
  return token;
}

export function resendSeconds(deadline: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function phoneAuthError(cause: unknown): string {
  const value =
    cause && typeof cause === "object"
      ? (cause as { code?: string; message?: string })
      : {};
  const code = value.code ?? "";
  const message = value.message ?? "";
  if (code === "otp_expired" || code === "otp_disabled")
    return "验证码不正确或已过期，请检查或重新获取。";
  if (code.includes("rate_limit") || /频繁|频控/.test(message))
    return "请求较频繁，请稍后再试。";
  if (/sms|phone_provider|hook/i.test(code))
    return "短信暂时无法发送，请稍后重试或使用邮箱登录。";
  if (/fetch|network|timeout/i.test(message))
    return "暂时无法连接登录服务，请稍后重试。";
  if (/[\u4e00-\u9fff]/.test(message)) return message.slice(0, 200);
  return "操作未完成，请稍后重试或使用邮箱登录。";
}

export type PhoneOtpTransport = {
  send: (phone: string) => Promise<void>;
  verify: (phone: string, token: string) => Promise<Session>;
};

export async function requestPhoneCode({
  transport,
  phone,
  accepted,
  resendAt,
  isCurrent,
  now = Date.now,
}: {
  transport: PhoneOtpTransport;
  phone: string;
  accepted: boolean;
  resendAt: number;
  isCurrent: () => boolean;
  now?: () => number;
}): Promise<{ phone: string; resendAt: number } | null> {
  if (!accepted) throw new Error("请先阅读并同意使用与隐私说明。");
  const normalized = normalizeMainlandPhone(phone);
  if (resendSeconds(resendAt, now()) > 0)
    throw new Error("请稍候再重新获取验证码。");
  if (!isCurrent()) return null;
  await transport.send(normalized);
  if (!isCurrent()) return null;
  return { phone: normalized, resendAt: now() + PHONE_RESEND_MS };
}

type OtpAuth = {
  signInWithOtp: (credentials: {
    phone: string;
    options: { shouldCreateUser: boolean; channel: "sms" };
  }) => Promise<{ error: unknown }>;
  verifyOtp: (params: {
    phone: string;
    token: string;
    type: "sms";
  }) => Promise<{ data: { session: Session | null }; error: unknown }>;
  dispose: () => Promise<void>;
};

function createOtpAuth(): OtpAuth {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("账号服务尚未配置完成，请稍后重试。");
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `xiaodian-profit:phone:${crypto.randomUUID()}`,
    },
  }).auth;
}

export function createPhoneOtpTransport(
  makeAuth: () => OtpAuth = createOtpAuth,
): PhoneOtpTransport {
  return {
    async send(phone) {
      const normalized = normalizeMainlandPhone(phone);
      const auth = makeAuth();
      try {
        const { error } = await auth.signInWithOtp({
          phone: normalized,
          options: { shouldCreateUser: true, channel: "sms" },
        });
        if (error) throw error;
      } finally {
        await auth.dispose();
      }
    },
    async verify(phone, token) {
      const normalized = normalizeMainlandPhone(phone);
      const verifiedToken = validatePhoneOtp(token);
      const auth = makeAuth();
      try {
        const { data, error } = await auth.verifyOtp({
          phone: normalized,
          token: verifiedToken,
          type: "sms",
        });
        if (error) throw error;
        if (!data.session)
          throw new Error("验证未完成，请重新获取短信验证码。");
        return data.session;
      } finally {
        // Verification is isolated until the current form accepts its response.
        await auth.dispose();
      }
    },
  };
}

export async function acceptPhoneVerification({
  transport,
  phone,
  token,
  isCurrent,
  getCurrentSession,
  setSession,
}: {
  transport: PhoneOtpTransport;
  phone: string;
  token: string;
  isCurrent: () => boolean;
  getCurrentSession: () => Promise<Session | null>;
  setSession: (session: {
    access_token: string;
    refresh_token: string;
  }) => Promise<void>;
}): Promise<boolean> {
  const normalized = normalizeMainlandPhone(phone);
  const verifiedToken = validatePhoneOtp(token);
  if (!isCurrent()) return false;
  const session = await transport.verify(normalized, verifiedToken);
  if (!isCurrent()) return false;
  if (
    !session.user.phone ||
    normalizeMainlandPhone(session.user.phone) !== normalized
  )
    throw new Error("验证返回的手机号不一致，请重新获取验证码。");
  const current = await getCurrentSession();
  if (!isCurrent()) return false;
  if (current)
    throw new Error("当前已登录其他账号，请退出后再使用手机号登录。");
  // Keep the SDK's normal persistence and auth notifications. The form locks
  // interaction during this handoff; cross-tab sign-ins still follow SDK order.
  await setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  return isCurrent();
}
