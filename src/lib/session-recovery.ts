import type {
  AuthChangeEvent,
  Session,
  SupabaseClient,
} from "@supabase/supabase-js";

type SessionAuth = Pick<
  SupabaseClient["auth"],
  "getSession" | "onAuthStateChange"
>;

export function createSessionRecovery({
  auth,
  onSession,
  onError,
}: {
  auth: SessionAuth;
  onSession: (session: Session | null, event: AuthChangeEvent) => void;
  onError: (error: unknown) => void;
}) {
  let active = true;
  let generation = 0;
  let retryPending = false;
  let signingOut = false;
  let inFlight: Promise<void> | null = null;

  function invalidate() {
    generation += 1;
    retryPending = false;
    inFlight = null;
  }

  const { data: subscription } = auth.onAuthStateChange((event, session) => {
    if (!active || (signingOut && event !== "SIGNED_OUT")) return;
    // This event can contain null after a temporary refresh failure, or a stale
    // snapshot after sign-out. Only the guarded explicit read confirms startup.
    if (event === "INITIAL_SESSION") return;
    invalidate();
    onSession(session, event);
  });

  async function restore() {
    if (!active || signingOut) return;
    if (inFlight) return inFlight;
    const current = generation;
    const attempt = (async () => {
      try {
        const { data, error } = await auth.getSession();
        if (!active || current !== generation) return;
        if (error) throw error;
        retryPending = false;
        onSession(data.session, "INITIAL_SESSION");
      } catch (error) {
        if (!active || current !== generation) return;
        retryPending = true;
        onError(error);
      }
    })();
    inFlight = attempt;
    try {
      await attempt;
    } finally {
      if (inFlight === attempt) inFlight = null;
    }
  }

  return {
    restore,
    needsRetry: () => active && retryPending,
    beginSignOut() {
      signingOut = true;
      invalidate();
    },
    completeSignOut() {
      signingOut = false;
    },
    dispose() {
      active = false;
      invalidate();
      subscription.subscription.unsubscribe();
    },
  };
}
