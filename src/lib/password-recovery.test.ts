import test from "node:test";
import assert from "node:assert/strict";
import { createClient, type User } from "@supabase/supabase-js";
import {
  isCurrentRecovery,
  readPasswordRecovery,
  recoverySessionId,
  RECOVERY_MAX_AGE_MS,
  updateRecoveryPassword,
} from "./password-recovery.ts";

const now = 1_800_000_000_000;
const identity = {
  userId: "A",
  sessionId: "A-session",
  email: "a@example.test",
  startedAt: now,
};

test("a recovery marker survives reload only for its original account", () => {
  const restored = readPasswordRecovery(JSON.stringify(identity), now + 1000);
  assert.ok(isCurrentRecovery(restored, "A", "A-session", now + 1000));
  assert.equal(
    isCurrentRecovery(restored, "B", "B-session", now + 1000),
    false,
  );
  assert.equal(isCurrentRecovery(restored, null, null, now + 1000), false);
  assert.equal(
    isCurrentRecovery(restored, "A", "new-A-session", now + 1000),
    false,
  );
  assert.equal(
    isCurrentRecovery(readPasswordRecovery(null, now), "A", "A-session", now),
    false,
  );
  assert.deepEqual(Object.keys(restored!).sort(), [
    "email",
    "sessionId",
    "startedAt",
    "userId",
  ]);
});

test("expired, future and malformed markers cannot resume password recovery", () => {
  assert.equal(
    readPasswordRecovery(JSON.stringify(identity), now + RECOVERY_MAX_AGE_MS),
    null,
  );
  assert.equal(readPasswordRecovery(JSON.stringify(identity), now - 1), null);
  for (const raw of ["null", "{}", "broken", '{"userId":"A","startedAt":0}'])
    assert.equal(readPasswordRecovery(raw, now), null);
  assert.equal(
    isCurrentRecovery(identity, "A", "A-session", now + RECOVERY_MAX_AGE_MS),
    false,
  );
});

function sourceAuth(userId = "A", sessionId = `${userId}-session`) {
  return {
    getSession: async () => ({
      data: {
        session: {
          user: { id: userId },
          access_token: jwt(userId, sessionId),
          refresh_token: "A-refresh",
        },
      },
      error: null,
    }),
    getUser: async (_jwt: string) => ({
      data: { user: { id: userId } },
      error: null,
    }),
  };
}

test("an account switch before submission never constructs a password client", async () => {
  let constructed = false;
  await assert.rejects(
    updateRecoveryPassword(
      sourceAuth("B"),
      identity,
      "new-password1",
      () => true,
      () => {
        constructed = true;
        throw new Error("must not construct");
      },
    ),
    /账号已变化/,
  );
  assert.equal(constructed, false);
});

test("switching accounts while getUser verifies A cancels before any update", async () => {
  let current = true;
  const source = sourceAuth();
  source.getUser = async () => {
    current = false;
    return { data: { user: { id: "A" } }, error: null };
  };
  let constructed = false;
  await assert.rejects(
    updateRecoveryPassword(
      source,
      identity,
      "new-password1",
      () => current,
      () => {
        constructed = true;
        throw new Error("must not construct");
      },
    ),
    /账号已变化/,
  );
  assert.equal(constructed, false);
});

test("the Auth server identity must match the recovery account", async () => {
  const source = sourceAuth();
  source.getUser = async () => ({ data: { user: { id: "B" } }, error: null });
  await assert.rejects(
    updateRecoveryPassword(
      source,
      identity,
      "new-password1",
      () => true,
      () => {
        throw new Error("must not construct");
      },
    ),
    /账号已变化/,
  );
});

test("a failed password update disposes its temporary client", async () => {
  let disposed = false;
  await assert.rejects(
    updateRecoveryPassword(
      sourceAuth(),
      identity,
      "new-password1",
      () => true,
      () => ({
        setSession: async () => ({ data: { user: { id: "A" } }, error: null }),
        updateUser: async () => ({
          data: { user: null },
          error: new Error("network failed"),
        }),
        dispose: async () => {
          disposed = true;
        },
      }),
    ),
    /network failed/,
  );
  assert.equal(disposed, true);
});

function user(id: string): User {
  return {
    id,
    email: `${id.toLowerCase()}@example.test`,
    aud: "authenticated",
    role: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-10-16T00:00:00Z",
  };
}

function jwt(id: string, sessionId = `${id}-session`) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: id, session_id: sessionId, exp: Math.floor(Date.now() / 1000) + 3600 })}.test-signature`;
}

test("a normal new login to the same account cannot reuse an earlier recovery marker", async () => {
  assert.equal(recoverySessionId(jwt("A")), "A-session");
  assert.equal(recoverySessionId("invalid-token"), null);
  await assert.rejects(
    updateRecoveryPassword(
      sourceAuth("A", "new-A-session"),
      identity,
      "new-password1",
      () => true,
      () => {
        throw new Error("must not construct");
      },
    ),
    /账号已变化/,
  );
});

test("SDK password updates stay bound to A if the primary client switches to B mid-request", async () => {
  const accessA = jwt("A");
  const accessB = jwt("B");
  const changedAccounts: string[] = [];
  const methods: string[] = [];
  let currentUserId = "A";
  let switchOnUpdate = false;
  const fakeFetch: typeof fetch = async (_input, init) => {
    const method = init?.method ?? "GET";
    methods.push(method);
    const auth = new Headers(init?.headers).get("Authorization");
    const id =
      auth === `Bearer ${accessA}`
        ? "A"
        : auth === `Bearer ${accessB}`
          ? "B"
          : null;
    assert.ok(id, "every Auth request must use a captured test account token");
    if (method === "PUT") {
      if (switchOnUpdate) {
        currentUserId = "B";
        await primary.auth.setSession({
          access_token: accessB,
          refresh_token: "B-refresh",
        });
      }
      changedAccounts.push(id);
    }
    return new Response(JSON.stringify(user(id)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const makeClient = () =>
    createClient("https://recovery-test.invalid", "test-publishable-key", {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: `password-recovery-test-${crypto.randomUUID()}`,
      },
      global: { fetch: fakeFetch },
    });
  const primary = makeClient();
  try {
    const initialized = await primary.auth.setSession({
      access_token: accessA,
      refresh_token: "A-refresh",
    });
    assert.equal(initialized.error, null);
    await updateRecoveryPassword(
      primary.auth,
      identity,
      "new-password1",
      () => currentUserId === "A",
      () => makeClient().auth,
    );
    assert.deepEqual(changedAccounts, ["A"]);

    switchOnUpdate = true;
    await assert.rejects(
      updateRecoveryPassword(
        primary.auth,
        identity,
        "new-password2",
        () => currentUserId === "A",
        () => makeClient().auth,
      ),
      /账号已变化/,
    );
    assert.deepEqual(changedAccounts, ["A", "A"]);
    assert.equal((await primary.auth.getSession()).data.session?.user.id, "B");
    assert.equal(
      methods.includes("POST"),
      false,
      "temporary clients must not sign out or revoke the primary session",
    );
  } finally {
    await primary.auth.dispose();
  }
});
