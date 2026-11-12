import { AuthRetryableFetchError } from "@supabase/supabase-js";

// A throttled refresh is temporary, not evidence that the login was revoked.
// Scope this adapter to the configured Auth refresh endpoint only. The SDK
// continues to handle invalid credentials, sign-out and all other responses.
export function createAuthRefreshFetch(
  supabaseUrl: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const origin = new URL(supabaseUrl).origin;
  let blockedUntil = 0;
  const throttled = () =>
    new AuthRetryableFetchError("登录服务暂时繁忙，请稍后重试。", 429);

  return async (input, init) => {
    let isRefresh = false;
    try {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      const method =
        init?.method ??
        (typeof input === "object" && "method" in input ? input.method : "GET");
      isRefresh =
        method.toUpperCase() === "POST" &&
        url.origin === origin &&
        url.pathname === "/auth/v1/token" &&
        url.searchParams.getAll("grant_type").length === 1 &&
        url.searchParams.get("grant_type") === "refresh_token";
    } catch {
      // Preserve native fetch behavior for malformed or unrelated requests.
    }
    if (isRefresh && Date.now() < blockedUntil) throw throttled();

    const response = await fetcher(input, init);
    if (!isRefresh || response.status !== 429) return response;

    const retryAfter = response.headers.get("retry-after");
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const deadline = Number.isFinite(seconds)
      ? Date.now() + Math.max(0, seconds) * 1000
      : Date.parse(retryAfter ?? "");
    // SDK backoff must not repeatedly hit a rate-limited server. Honor a
    // longer Retry-After, with a one-minute floor when absent or too short.
    blockedUntil = Math.max(
      Date.now() + 60_000,
      Number.isFinite(deadline) ? deadline : 0,
    );
    await response.body?.cancel().catch(() => {});
    throw throttled();
  };
}
