import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAuthRefreshFetch } from "./auth-refresh-fetch";

export const cloudConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
);
let client: SupabaseClient | null = null;

export function getSupabase() {
  if (!cloudConfigured) return null;
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        global: {
          fetch: createAuthRefreshFetch(process.env.NEXT_PUBLIC_SUPABASE_URL!),
        },
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          // Keep the existing session when moving this project's API hostname.
          ...(process.env.NEXT_PUBLIC_SUPABASE_STORAGE_KEY
            ? { storageKey: process.env.NEXT_PUBLIC_SUPABASE_STORAGE_KEY }
            : {}),
        },
      },
    );
  }
  return client;
}

export function friendlyError(error: unknown): string {
  const record =
    error && typeof error === "object"
      ? (error as { code?: string; message?: string })
      : {};
  const code = record.code ?? "";
  const message = record.message ?? (typeof error === "string" ? error : "");
  if (code === "invalid_credentials") return "邮箱或密码不正确，请重新检查。";
  if (code === "email_not_confirmed")
    return "请先打开注册邮件，完成邮箱确认后再登录。";
  if (code === "email_address_not_authorized")
    return "注册邮件发送失败，请联系网站管理员检查邮件服务配置。";
  if (code === "user_already_exists")
    return "这个邮箱已经注册，请直接登录或找回密码。";
  if (code.includes("rate_limit") || code === "over_email_send_rate_limit")
    return "请求较频繁，请稍后再试。";
  if (code === "weak_password")
    return "密码强度不足，请使用至少 10 位的字母和数字组合。";
  if (code === "40001" || /version|conflict|版本|冲突/i.test(message))
    return "记录已发生变化，请刷新后重新打开修改。";
  if (code === "42501") return "登录状态失效或没有操作权限，请重新登录。";
  if (code === "PGRST116")
    return "记录已发生变化或不再可用，请刷新后重新打开修改。";
  if (code === "23503") return "商品或记录已发生变化，请刷新后重试。";
  if (code === "23514" && message.startsWith("库存不足或数量超出上限："))
    return message.slice(0, 250);
  if (code === "23514" || code === "22003")
    return "金额、数量或销售明细不符合要求，请检查后重试。";
  if (code === "23505") return "记录已存在，请刷新列表查看，避免重复录入。";
  if (/fetch|network|Failed to fetch|timeout/i.test(message))
    return "网络连接失败，请检查网络后重试；销售重试不会重复新增。";
  if (/[\u4e00-\u9fff]/.test(message)) return message.slice(0, 250);
  return "操作没有完成，请稍后重试。若仍失败，请刷新页面或重新登录。";
}
