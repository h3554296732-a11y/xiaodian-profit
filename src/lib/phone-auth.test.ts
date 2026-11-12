import test from "node:test";
import assert from "node:assert/strict";
import { createClient, type Session } from "@supabase/supabase-js";
import {
  acceptPhoneVerification,
  createPhoneOtpTransport,
  normalizeMainlandPhone,
  PHONE_RESEND_MS,
  requestPhoneCode,
  resendSeconds,
  validatePhoneOtp,
} from "./phone-auth.ts";

// Synthetic fixtures are only passed to mocks; these tests never send an SMS.
const phoneA = "+8619900000000";
const phoneB = "+8619900000001";
const session = (phone = phoneA, id = "phone-A"): Session => ({
  access_token: `${id}-access`,
  refresh_token: `${id}-refresh`,
  expires_in: 3600,
  token_type: "bearer",
  user: {
    id,
    phone,
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-10-16T00:00:00Z",
  },
});

test("mainland numbers normalize to +86 and reject invalid or foreign numbers", () => {
  for (const input of [
    "19900000000",
    phoneA,
    "008619900000000",
    "8619900000000",
    "199 0000 0000",
  ])
    assert.equal(normalizeMainlandPhone(input), phoneA);
  for (const input of [
    "",
    "1990000000",
    "199000000000",
    "+12125551212",
    "12900000000",
    "1990000000x",
  ])
    assert.throws(() => normalizeMainlandPhone(input), /11 位中国大陆手机号/);
});

test("six digit OTP validation preserves leading zeroes", () => {
  assert.equal(validatePhoneOtp("001234"), "001234");
  for (const token of ["", "12345", "1234567", "12a456"])
    assert.throws(() => validatePhoneOtp(token), /6 位验证码/);
});

test("resend cooldown uses its deadline after background tab throttling", () => {
  const start = 1_000_000;
  const deadline = start + PHONE_RESEND_MS;
  assert.equal(resendSeconds(deadline, start), 60);
  assert.equal(resendSeconds(deadline, start + 10_050), 50);
  assert.equal(resendSeconds(deadline, start + 125_000), 0);
});

test("SMS requests explicitly allow signup and failed sends never verify a code", async () => {
  const sent: unknown[] = [];
  let verified = false;
  let disposed = 0;
  const transport = createPhoneOtpTransport(() => ({
    signInWithOtp: async (credentials) => {
      sent.push(credentials);
      return { error: new Error("delivery failed") };
    },
    verifyOtp: async () => {
      verified = true;
      return { data: { session: session() }, error: null };
    },
    dispose: async () => {
      disposed += 1;
    },
  }));
  await assert.rejects(transport.send("19900000000"), /delivery failed/);
  assert.deepEqual(sent, [
    { phone: phoneA, options: { shouldCreateUser: true, channel: "sms" } },
  ]);
  assert.equal(verified, false);
  assert.equal(disposed, 1);
});

test("consent and cooldown are checked before any SMS signup request", async () => {
  let sends = 0;
  const transport = {
    send: async () => {
      sends += 1;
    },
    verify: async () => session(),
  };
  const params = {
    transport,
    phone: phoneA,
    accepted: false,
    resendAt: 0,
    isCurrent: () => true,
    now: () => 1000,
  };
  await assert.rejects(requestPhoneCode(params), /先阅读并同意/);
  await assert.rejects(
    requestPhoneCode({ ...params, accepted: true, resendAt: 2000 }),
    /请稍候/,
  );
  assert.equal(sends, 0);
  assert.deepEqual(await requestPhoneCode({ ...params, accepted: true }), {
    phone: phoneA,
    resendAt: 61_000,
  });
  assert.equal(sends, 1);
});

test("failed or stale sends produce no transition to code entry", async () => {
  const response = deferred<void>();
  let current = true;
  const params = {
    transport: {
      send: async () => response.promise,
      verify: async () => session(),
    },
    phone: phoneA,
    accepted: true,
    resendAt: 0,
    isCurrent: () => current,
  };
  const result = requestPhoneCode(params);
  current = false;
  response.resolve();
  assert.equal(await result, null);
  await assert.rejects(
    requestPhoneCode({
      ...params,
      isCurrent: () => true,
      transport: {
        ...params.transport,
        send: async () => {
          throw new Error("delivery failed");
        },
      },
    }),
    /delivery failed/,
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("late verification after unmount or switching login method cannot adopt a session", async () => {
  const response = deferred<Session>();
  let mounted = true;
  let adopted = 0;
  const result = acceptPhoneVerification({
    phone: phoneA,
    token: "001234",
    isCurrent: () => mounted,
    transport: { send: async () => {}, verify: async () => response.promise },
    getCurrentSession: async () => null,
    setSession: async () => {
      adopted += 1;
    },
  });
  mounted = false;
  response.resolve(session());
  assert.equal(await result, false);
  assert.equal(adopted, 0);
});

test("an older phone response cannot replace the latest phone login", async () => {
  const old = deferred<Session>();
  const adopted: string[] = [];
  let generation = 1;
  const transport = {
    send: async () => {},
    verify: async (phone: string) =>
      phone === phoneA ? old.promise : session(phoneB, "phone-B"),
  };
  const first = acceptPhoneVerification({
    phone: phoneA,
    token: "001234",
    transport,
    isCurrent: () => generation === 1,
    getCurrentSession: async () => null,
    setSession: async (value) => {
      adopted.push(value.access_token);
    },
  });
  generation = 2;
  assert.equal(
    await acceptPhoneVerification({
      phone: phoneB,
      token: "005678",
      transport,
      isCurrent: () => generation === 2,
      getCurrentSession: async () => null,
      setSession: async (value) => {
        adopted.push(value.access_token);
      },
    }),
    true,
  );
  old.resolve(session());
  assert.equal(await first, false);
  assert.deepEqual(adopted, ["phone-B-access"]);
});

test("an existing primary account prevents a phone verification from replacing it", async () => {
  let adopted = false;
  await assert.rejects(
    acceptPhoneVerification({
      phone: phoneA,
      token: "001234",
      isCurrent: () => true,
      transport: { send: async () => {}, verify: async () => session() },
      getCurrentSession: async () => session(phoneB, "existing-B"),
      setSession: async () => {
        adopted = true;
      },
    }),
    /当前已登录其他账号/,
  );
  assert.equal(adopted, false);
});

test("cancellation while checking the primary session stops the handoff", async () => {
  const primary = deferred<Session | null>();
  const checking = deferred<void>();
  let current = true;
  let adopted = false;
  const result = acceptPhoneVerification({
    phone: phoneA,
    token: "001234",
    isCurrent: () => current,
    transport: { send: async () => {}, verify: async () => session() },
    getCurrentSession: async () => {
      checking.resolve();
      return primary.promise;
    },
    setSession: async () => {
      adopted = true;
    },
  });
  await checking.promise;
  current = false;
  primary.resolve(null);
  assert.equal(await result, false);
  assert.equal(adopted, false);
});

test("a verification response for another number is rejected", async () => {
  let adopted = false;
  await assert.rejects(
    acceptPhoneVerification({
      phone: phoneA,
      token: "001234",
      isCurrent: () => true,
      transport: { send: async () => {}, verify: async () => session(phoneB) },
      getCurrentSession: async () => null,
      setSession: async () => {
        adopted = true;
      },
    }),
    /手机号不一致/,
  );
  assert.equal(adopted, false);
});

test("real SDK SMS transport keeps verified sessions isolated and uses type sms", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let writes = 0;
  let disposed = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
    const body = url.pathname.endsWith("/verify") ? session() : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const transport = createPhoneOtpTransport(() => {
    const client = createClient(
      "https://phone-test.invalid",
      "test-publishable-key",
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
          storageKey: `phone-auth-test-${crypto.randomUUID()}`,
          storage: {
            getItem: () => null,
            setItem: () => {
              writes += 1;
            },
            removeItem: () => {
              writes += 1;
            },
          },
        },
        global: { fetch: fakeFetch },
      },
    );
    const dispose = client.auth.dispose.bind(client.auth);
    client.auth.dispose = async () => {
      disposed += 1;
      await dispose();
    };
    return client.auth;
  });
  await transport.send(phoneA);
  const verified = await transport.verify(phoneA, "001234");
  assert.equal(verified.user.phone, phoneA);
  assert.equal(requests[0].body.create_user, true);
  assert.deepEqual(requests[1].body, {
    phone: phoneA,
    token: "001234",
    type: "sms",
    gotrue_meta_security: {},
  });
  assert.equal(writes, 0);
  assert.equal(disposed, 2);
});
