import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createClient, type Session, type User } from "@supabase/supabase-js";
import { createSessionRecovery } from "./session-recovery.ts";
import { createAuthRefreshFetch } from "./auth-refresh-fetch.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(
  t: TestContext,
  initial: "valid" | "expired" | "empty",
  offline = false,
) {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const key = `session-recovery-test-${crypto.randomUUID()}`;
  const storage = new Map<string, string>();
  const requests: string[] = [];
  let mode:
    | "success"
    | "offline"
    | "invalid"
    | "unauthorized"
    | "limited-json"
    | "limited-html" = offline ? "offline" : "success";
  let readGate: ReturnType<typeof deferred<void>> | null = null;
  let readStarted: ReturnType<typeof deferred<void>> | null = null;
  let storageGate: ReturnType<typeof deferred<void>> | null = null;
  let storageReadStarted: ReturnType<typeof deferred<void>> | null = null;
  let logoutGate: ReturnType<typeof deferred<void>> | null = null;
  let logoutStarted: ReturnType<typeof deferred<void>> | null = null;
  const user = (id: string): User => ({
    id,
    aud: "authenticated",
    role: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-10-01T00:00:00Z",
  });
  function session(id = "A", expired = false): Session {
    const exp = Math.floor(now / 1000) + (expired ? -3600 : 3600);
    const payload = Buffer.from(
      JSON.stringify({ sub: id, session_id: `${id}-session`, exp }),
    ).toString("base64url");
    return {
      access_token: `e30.${payload}.synthetic-signature`,
      refresh_token: `synthetic-${id}-${now}`,
      token_type: "bearer",
      expires_at: exp,
      expires_in: 3600,
      user: user(id),
    };
  }
  if (initial !== "empty")
    storage.set(key, JSON.stringify(session("A", initial === "expired")));
  const withMockRetryBudget =
    (fetcher: typeof globalThis.fetch): typeof globalThis.fetch =>
    async (input, init) => {
      try {
        return await fetcher(input, init);
      } catch (error) {
        // The adapter's local cooldown throws before the mocked network runs.
        // Exhaust that SDK attempt's budget as well, without real sleeps.
        now += 31_000;
        throw error;
      }
    };
  const client = createClient(
    "https://session-test.invalid",
    "synthetic-publishable-key",
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: key,
        storage: {
          getItem: async (name) => {
            const snapshot = storage.get(name) ?? null;
            if (name === key && storageGate) {
              const gate = storageGate;
              storageGate = null;
              storageReadStarted?.resolve();
              await gate.promise;
            }
            return snapshot;
          },
          setItem: (name, value) => {
            storage.set(name, value);
          },
          removeItem: (name) => {
            storage.delete(name);
          },
        },
      },
      global: {
        // Every SDK request is answered here. No real network request is allowed.
        fetch: withMockRetryBudget(
          createAuthRefreshFetch(
            "https://session-test.invalid",
            async (input, init) => {
              const url = new URL(String(input));
              assert.equal(url.origin, "https://session-test.invalid");
              requests.push(url.pathname);
              if (url.pathname === "/auth/v1/token") {
                assert.equal(
                  url.searchParams.get("grant_type"),
                  "refresh_token",
                );
                assert.ok(JSON.parse(String(init?.body)).refresh_token);
                if (mode === "limited-json" || mode === "limited-html") {
                  // Exhaust the SDK retry budget without real waiting. The
                  // adapter must not send a second request during Retry-After.
                  now += 31_000;
                  return new Response(
                    mode === "limited-json"
                      ? JSON.stringify({
                          error_code: "over_request_rate_limit",
                        })
                      : "<html>Too Many Requests</html>",
                    {
                      status: 429,
                      headers: {
                        "content-type":
                          mode === "limited-json"
                            ? "application/json"
                            : "text/html",
                        "retry-after": "120",
                      },
                    },
                  );
                }
                if (mode === "offline") {
                  // End the SDK's 30-second retry budget without real waiting.
                  now += 31_000;
                  return Response.json(
                    { message: "synthetic gateway unavailable" },
                    { status: 503 },
                  );
                }
                if (mode === "invalid" || mode === "unauthorized")
                  return Response.json(
                    {
                      message: "synthetic refresh rejected",
                      error_code: "refresh_token_not_found",
                    },
                    { status: mode === "unauthorized" ? 401 : 400 },
                  );
                return Response.json(session());
              }
              if (url.pathname === "/auth/v1/user") {
                const token = new Headers(init?.headers)
                  .get("Authorization")!
                  .slice(7);
                const claims = JSON.parse(
                  Buffer.from(token.split(".")[1], "base64url").toString(),
                );
                return Response.json(user(claims.sub));
              }
              if (url.pathname === "/auth/v1/logout") {
                logoutStarted?.resolve();
                if (logoutGate) await logoutGate.promise;
                return new Response(null, { status: 204 });
              }
              throw new Error(`Unexpected mocked route: ${url.pathname}`);
            },
          ),
        ),
      },
    },
  );
  const state = {
    user: null as string | null,
    error: false,
    updates: [] as string[],
  };
  const recovery = createSessionRecovery({
    auth: {
      onAuthStateChange: client.auth.onAuthStateChange.bind(client.auth),
      getSession: async () => {
        const gate = readGate;
        const started = readStarted;
        readGate = null;
        readStarted = null;
        const result = await client.auth.getSession();
        started?.resolve();
        if (gate) await gate.promise;
        return result;
      },
    },
    onSession(value, event) {
      state.user = value?.user.id ?? null;
      state.error = false;
      state.updates.push(`${event}:${state.user ?? "signed-out"}`);
    },
    onError() {
      state.error = true;
      state.updates.push("recovery-error");
    },
  });
  t.after(async () => {
    recovery.dispose();
    await client.auth.dispose();
  });
  return {
    client,
    recovery,
    state,
    storage,
    key,
    requests,
    session,
    advance: (ms: number) => {
      now += ms;
    },
    setMode: (next: typeof mode) => {
      mode = next;
    },
    pauseRead() {
      const gate = deferred<void>();
      const started = deferred<void>();
      readGate = gate;
      readStarted = started;
      return { started: started.promise, release: () => gate.resolve() };
    },
    pauseLogout() {
      const gate = deferred<void>();
      const started = deferred<void>();
      logoutGate = gate;
      logoutStarted = started;
      return { started: started.promise, release: () => gate.resolve() };
    },
    pauseStorage() {
      const gate = deferred<void>();
      const started = deferred<void>();
      storageGate = gate;
      storageReadStarted = started;
      return { started: started.promise, release: () => gate.resolve() };
    },
    async restore() {
      await recovery.restore();
      await setImmediate();
    },
  };
}

test("a saved valid session opens the original account without a refresh request", async (t) => {
  const h = harness(t, "valid");
  await h.restore();
  assert.equal(h.state.user, "A");
  assert.equal(h.state.error, false);
  assert.deepEqual(h.requests, []);
});

test("an expired session uses the real SDK refresh path and persists its rotated session", async (t) => {
  const h = harness(t, "expired");
  const original = h.storage.get(h.key);
  await h.restore();
  assert.equal(h.state.user, "A");
  assert.equal(h.state.error, false);
  assert.equal(h.requests.filter((path) => path.endsWith("/token")).length, 1);
  assert.notEqual(h.storage.get(h.key), original);
  assert.ok(JSON.parse(h.storage.get(h.key)!).expires_at * 1000 > Date.now());
});

for (const mode of ["limited-json", "limited-html"] as const) {
  test(`an expired-session ${mode} 429 retains login and respects Retry-After`, async (t) => {
    const h = harness(t, "expired");
    h.setMode(mode);
    const original = h.storage.get(h.key);
    await h.restore();
    assert.equal(h.state.error, true);
    assert.equal(h.recovery.needsRetry(), true);
    assert.equal(h.storage.get(h.key), original);
    assert.equal(h.requests.length, 1);
    assert.equal(
      h.state.updates.some((event) => event.startsWith("SIGNED_OUT")),
      false,
    );

    h.setMode("success");
    h.advance(61_000);
    await h.restore();
    assert.equal(
      h.requests.length,
      1,
      "Retry-After still blocks real requests",
    );
    assert.equal(h.state.error, true);
    assert.equal(h.storage.get(h.key), original);

    h.advance(61_000);
    await h.restore();
    assert.equal(h.requests.length, 2);
    assert.equal(h.state.user, "A");
    assert.equal(h.state.error, false);
    assert.notEqual(h.storage.get(h.key), original);
  });
}

test("a later 429 after hours of inactivity preserves the current account", async (t) => {
  const h = harness(t, "valid");
  await h.restore();
  const original = h.storage.get(h.key);
  h.advance(7 * 60 * 60_000);
  h.setMode("limited-json");
  await h.restore();
  assert.equal(h.state.user, "A");
  assert.equal(h.state.error, true);
  assert.equal(h.storage.get(h.key), original);
  assert.equal(
    h.state.updates.some((event) => event.startsWith("SIGNED_OUT")),
    false,
  );
  h.setMode("success");
  h.advance(121_000);
  await h.restore();
  assert.equal(h.state.user, "A");
  assert.equal(h.state.error, false);
  assert.equal(h.requests.length, 2);
});

test("429 handling leaves other grants, origins and ledger writes unchanged", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const responses: Response[] = [];
  const fetcher = createAuthRefreshFetch(
    "https://session-test.invalid",
    async (input, init) => {
      requests.push({ input, init });
      const response = new Response("rate limited", { status: 429 });
      responses.push(response);
      return response;
    },
  );
  const cases: Array<[string, RequestInit]> = [
    [
      "https://session-test.invalid/auth/v1/token?grant_type=password",
      { method: "POST" },
    ],
    ["https://session-test.invalid/auth/v1/otp", { method: "POST" }],
    ["https://session-test.invalid/auth/v1/verify", { method: "POST" }],
    [
      "https://session-test.invalid/auth/v1/logout?scope=local",
      { method: "POST" },
    ],
    [
      "https://session-test.invalid/rest/v1/rpc/save_sale",
      { method: "POST", body: "synthetic-ledger-write" },
    ],
    [
      "https://other.invalid/auth/v1/token?grant_type=refresh_token",
      { method: "POST" },
    ],
    [
      "https://session-test.invalid/auth/v1/token?grant_type=refresh_token",
      { method: "GET" },
    ],
    [
      "https://session-test.invalid/auth/v1/token?grant_type=refresh_token&grant_type=password",
      { method: "POST" },
    ],
  ];
  for (const [input, init] of cases) {
    const response = await fetcher(input, init);
    assert.equal(response, responses.at(-1));
    assert.equal(response.status, 429);
    assert.equal(response.bodyUsed, false);
    assert.equal(requests.at(-1)?.input, input);
    assert.equal(requests.at(-1)?.init, init);
  }
  assert.equal(
    requests.length,
    cases.length,
    "no added retry or duplicate ledger write",
  );
});

test("the refresh adapter accepts Request input and HTTP-date Retry-After", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  const fetcher = createAuthRefreshFetch(
    "https://session-test.invalid",
    async () => {
      calls++;
      if (calls > 1) return new Response("ok");
      return new Response(null, {
        status: 429,
        headers: { "retry-after": new Date(now + 120_000).toUTCString() },
      });
    },
  );
  const input = new Request(
    "https://session-test.invalid/auth/v1/token?grant_type=refresh_token",
    { method: "POST" },
  );
  await assert.rejects(fetcher(input), {
    name: "AuthRetryableFetchError",
    status: 429,
  });
  now += 61_000;
  await assert.rejects(fetcher(input), {
    name: "AuthRetryableFetchError",
    status: 429,
  });
  assert.equal(calls, 1);
  now += 60_000;
  assert.equal((await fetcher(input)).status, 200);
  assert.equal(calls, 2);
});

test("a 429 without Retry-After uses a finite one-minute cooldown", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  const fetcher = createAuthRefreshFetch(
    "https://session-test.invalid",
    async () => {
      calls++;
      return new Response(null, { status: calls === 1 ? 429 : 200 });
    },
  );
  const url = new URL(
    "https://session-test.invalid/auth/v1/token?grant_type=refresh_token",
  );
  await assert.rejects(fetcher(url, { method: "POST" }));
  now += 59_999;
  await assert.rejects(fetcher(url, { method: "POST" }));
  assert.equal(calls, 1);
  now++;
  assert.equal((await fetcher(url, { method: "POST" })).status, 200);
  assert.equal(calls, 2);
});

test("a successful refresh forwards the original request including cancellation", async () => {
  const input =
    "https://session-test.invalid/auth/v1/token?grant_type=refresh_token";
  const init = {
    method: "POST",
    body: "synthetic-refresh",
    headers: { apikey: "synthetic-public-key" },
    signal: new AbortController().signal,
  };
  const expected = new Response("synthetic refreshed session");
  const fetcher = createAuthRefreshFetch(
    "https://session-test.invalid",
    async (actualInput, actualInit) => {
      assert.equal(actualInput, input);
      assert.equal(actualInit, init);
      return expected;
    },
  );
  assert.equal(await fetcher(input, init), expected);
});

test("SDK INITIAL_SESSION null cannot hide an expired-session network error or discard its credentials", async (t) => {
  const h = harness(t, "expired", true);
  const original = h.storage.get(h.key);
  await h.restore();
  assert.equal(h.state.error, true);
  assert.equal(h.recovery.needsRetry(), true);
  assert.equal(h.storage.get(h.key), original);
  assert.deepEqual(h.state.updates, ["recovery-error"]);

  const attempted = h.requests.length;
  h.setMode("success");
  await h.restore();
  assert.equal(
    h.requests.length,
    attempted,
    "retry respects the SDK failure cooldown",
  );
  assert.equal(h.state.error, true);

  h.advance(61_000);
  await h.restore();
  assert.equal(h.state.user, "A");
  assert.equal(h.state.error, false);
  assert.equal(h.recovery.needsRetry(), false);
  assert.equal(h.requests.length, attempted + 1);
});

test("a genuinely rejected refresh token clears the session and requires a new login", async (t) => {
  const h = harness(t, "empty");
  await h.restore();
  h.storage.set(h.key, JSON.stringify(h.session("A", true)));
  h.setMode("invalid");
  await h.restore();
  assert.equal(h.storage.has(h.key), false);
  assert.equal(h.state.user, null);
  assert.equal(h.state.error, false);
  assert.equal(h.recovery.needsRetry(), false);
  assert.ok(h.state.updates.includes("SIGNED_OUT:signed-out"));
});

test("a refresh rejected with 401 is not treated as temporary throttling", async (t) => {
  const h = harness(t, "empty");
  await h.restore();
  h.storage.set(h.key, JSON.stringify(h.session("A", true)));
  h.setMode("unauthorized");
  await h.restore();
  assert.equal(h.storage.has(h.key), false);
  assert.equal(h.state.user, null);
  assert.ok(h.state.updates.includes("SIGNED_OUT:signed-out"));
});

test("retry can confirm an empty session without retaining a recovery error", async (t) => {
  const h = harness(t, "expired", true);
  await h.restore();
  h.storage.delete(h.key);
  await h.restore();
  assert.equal(h.state.user, null);
  assert.equal(h.state.error, false);
  assert.equal(h.recovery.needsRetry(), false);
});

test("a late successful read of account A cannot replace a new SDK sign-in to B", async (t) => {
  const h = harness(t, "valid");
  await h.restore();
  const read = h.pauseRead();
  const pending = h.recovery.restore();
  await read.started;
  const b = h.session("B");
  assert.equal((await h.client.auth.setSession(b)).error, null);
  assert.equal(h.state.user, "B");
  read.release();
  await pending;
  assert.equal(h.state.user, "B");
});

test("a late network error for A cannot hide a new SDK sign-in to B", async (t) => {
  const h = harness(t, "valid");
  await h.restore();
  h.storage.set(h.key, JSON.stringify(h.session("A", true)));
  h.setMode("offline");
  const read = h.pauseRead();
  const pending = h.recovery.restore();
  await read.started;
  assert.equal((await h.client.auth.setSession(h.session("B"))).error, null);
  read.release();
  await pending;
  assert.equal(h.state.user, "B");
  assert.equal(h.state.error, false);
  assert.equal(h.recovery.needsRetry(), false);
});

test("local sign-out suppresses both a late read and the SDK refresh before a delayed logout", async (t) => {
  const h = harness(t, "valid");
  await h.restore();
  const read = h.pauseRead();
  const pending = h.recovery.restore();
  await read.started;
  h.recovery.beginSignOut();
  h.state.user = null;
  h.state.updates.length = 0;
  h.storage.set(h.key, JSON.stringify(h.session("A", true)));
  const logout = h.pauseLogout();
  const signingOut = h.client.auth.signOut({ scope: "local" });
  await logout.started;
  read.release();
  await pending;
  assert.equal(h.state.user, null);
  assert.deepEqual(
    h.state.updates,
    [],
    "the intermediate TOKEN_REFRESHED must stay hidden",
  );
  logout.release();
  assert.equal((await signingOut).error, null);
  h.recovery.completeSignOut();
  assert.equal(h.state.user, null);
  assert.equal(h.storage.has(h.key), false);
  assert.deepEqual(h.state.updates, ["SIGNED_OUT:signed-out"]);
});

test("an SDK sign-out invalidates a successful read already in flight", async (t) => {
  const h = harness(t, "valid");
  await h.restore();
  const read = h.pauseRead();
  const pending = h.recovery.restore();
  await read.started;
  await h.client.auth.signOut({ scope: "local" });
  assert.equal(h.state.user, null);
  read.release();
  await pending;
  assert.equal(h.state.user, null);
  assert.equal(h.state.error, false);
});

test("failed offline sign-out stays blocked through background refresh until a real retry signs out", async (t) => {
  const h = harness(t, "valid");
  await h.restore();
  h.storage.set(h.key, JSON.stringify(h.session("A", true)));
  h.setMode("offline");
  h.recovery.beginSignOut();
  h.state.user = null;
  h.state.updates.length = 0;
  const failed = await h.client.auth.signOut({ scope: "local" });
  assert.ok(
    failed.error,
    "the SDK cannot sign out if it cannot refresh the expired session",
  );
  assert.equal(
    h.storage.has(h.key),
    true,
    "the SDK retained its credentials after the failed exit",
  );
  assert.equal(
    h.requests.some((path) => path.endsWith("/logout")),
    false,
  );

  h.setMode("success");
  h.advance(61_000);
  const refreshed = await h.client.auth.refreshSession();
  assert.equal(refreshed.error, null);
  assert.ok(
    refreshed.data.session,
    "the SDK really refreshed its stored session",
  );
  await h.restore();
  assert.equal(
    h.state.user,
    null,
    "automatic refresh or restore must not silently reopen the old account",
  );
  assert.deepEqual(h.state.updates, []);

  h.recovery.beginSignOut();
  assert.equal((await h.client.auth.signOut({ scope: "local" })).error, null);
  h.recovery.completeSignOut();
  assert.equal(h.storage.has(h.key), false);
  assert.deepEqual(h.state.updates, ["SIGNED_OUT:signed-out"]);
  await h.restore();
  assert.equal(h.state.user, null);
  assert.equal(h.state.error, false);
});

test("the SDK's late nonempty INITIAL_SESSION cannot revive an account after sign-out", async (t) => {
  const h = harness(t, "empty");
  await h.restore();
  await h.client.auth.stopAutoRefresh();
  h.recovery.dispose();
  h.storage.set(h.key, JSON.stringify(h.session()));
  const read = h.pauseStorage();
  const updates: Array<string | null> = [];
  const recovery = createSessionRecovery({
    auth: h.client.auth,
    onSession: (session) => {
      updates.push(session?.user.id ?? null);
    },
    onError: (error) => {
      throw error;
    },
  });
  t.after(() => recovery.dispose());
  await read.started;
  await h.client.auth.signOut({ scope: "local" });
  assert.equal(h.storage.has(h.key), false);
  assert.deepEqual(updates, [null]);
  read.release();
  await setImmediate();
  assert.deepEqual(updates, [null]);
  await recovery.restore();
  assert.equal(updates.at(-1), null);
});

test("unmount unsubscribes and prevents an in-flight read from updating the old provider", async (t) => {
  const h = harness(t, "valid");
  await h.restore();
  const read = h.pauseRead();
  const pending = h.recovery.restore();
  await read.started;
  h.state.updates.length = 0;
  h.recovery.dispose();
  read.release();
  await pending;
  await h.client.auth.setSession(h.session("B"));
  assert.deepEqual(h.state.updates, []);
});
