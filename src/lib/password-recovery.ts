import { createClient } from "@supabase/supabase-js";

export const RECOVERY_STORAGE_KEY = "xiaodian-profit:password-recovery:v1";
export const RECOVERY_MAX_AGE_MS = 60 * 60 * 1000;
export type PasswordRecovery = {
  userId: string;
  sessionId: string;
  email: string | null;
  startedAt: number;
};

export function readPasswordRecovery(
  raw: string | null,
  now = Date.now(),
): PasswordRecovery | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PasswordRecovery> | null;
    if (
      !value ||
      typeof value.userId !== "string" ||
      !value.userId ||
      typeof value.sessionId !== "string" ||
      !value.sessionId ||
      (value.email !== null && typeof value.email !== "string") ||
      typeof value.startedAt !== "number" ||
      !Number.isSafeInteger(value.startedAt) ||
      now < value.startedAt ||
      now - value.startedAt >= RECOVERY_MAX_AGE_MS
    )
      return null;
    // Only retain the identity and time; never store an auth token here.
    return {
      userId: value.userId,
      sessionId: value.sessionId,
      email: value.email,
      startedAt: value.startedAt,
    };
  } catch {
    return null;
  }
}

export function isCurrentRecovery(
  recovery: PasswordRecovery | null,
  userId: string | null,
  sessionId: string | null,
  now = Date.now(),
): recovery is PasswordRecovery {
  return Boolean(
    recovery &&
    recovery.userId === userId &&
    recovery.sessionId === sessionId &&
    recovery.startedAt <= now &&
    now - recovery.startedAt < RECOVERY_MAX_AGE_MS,
  );
}

export function recoverySessionId(accessToken: string): string | null {
  try {
    const payload = accessToken.split(".")[1];
    const claims = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    );
    // This is only a session comparison. getUser verifies the token on submit.
    return typeof claims.session_id === "string" && claims.session_id
      ? claims.session_id
      : null;
  } catch {
    return null;
  }
}

type SessionSnapshot = {
  access_token: string;
  refresh_token: string;
  user: { id: string };
};
type SourceAuth = {
  getSession: () => Promise<{
    data: { session: SessionSnapshot | null };
    error: unknown;
  }>;
  getUser: (jwt: string) => Promise<{
    data: { user: { id: string } | null };
    error: unknown;
  }>;
};
type BoundAuth = {
  setSession: (session: {
    access_token: string;
    refresh_token: string;
  }) => Promise<{ data: { user: { id: string } | null }; error: unknown }>;
  updateUser: (attributes: {
    password: string;
  }) => Promise<{ data: { user: { id: string } | null }; error: unknown }>;
  dispose: () => Promise<void>;
};

function createBoundAuth(): BoundAuth {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: `xiaodian-profit:recovery:${crypto.randomUUID()}`,
      },
    },
  ).auth;
}

export async function updateRecoveryPassword(
  source: SourceAuth,
  expected: Pick<PasswordRecovery, "userId" | "sessionId">,
  password: string,
  isCurrent: () => boolean,
  makeBoundAuth: () => BoundAuth = createBoundAuth,
): Promise<void> {
  const changed = () =>
    new Error("密码重置状态已失效或账号已变化，请为对应邮箱重新申请重置邮件。");
  const assertCurrent = () => {
    if (!isCurrent()) throw changed();
  };
  assertCurrent();
  const { data, error } = await source.getSession();
  if (error) throw error;
  const session = data.session;
  if (
    !session ||
    session.user.id !== expected.userId ||
    recoverySessionId(session.access_token) !== expected.sessionId
  )
    throw changed();
  const accessToken = session.access_token;
  const refreshToken = session.refresh_token;
  // Verify the captured token on the Auth server, not just the stored user.
  const verified = await source.getUser(accessToken);
  if (verified.error) throw verified.error;
  if (verified.data.user?.id !== expected.userId) throw changed();
  assertCurrent();

  // A shared client's updateUser re-reads storage. Bind this operation to the
  // verified snapshot so a concurrent sign-in in another tab cannot change B.
  const bound = makeBoundAuth();
  try {
    const initialized = await bound.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (initialized.error) throw initialized.error;
    if (initialized.data.user?.id !== expected.userId) throw changed();
    assertCurrent();
    const updated = await bound.updateUser({ password });
    if (updated.error) throw updated.error;
    if (updated.data.user?.id !== expected.userId) throw changed();
    assertCurrent();
  } finally {
    // dispose only tears down this client; signOut would revoke A's session.
    await bound.dispose();
  }
}
