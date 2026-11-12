import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSmsHandler } from "../supabase/functions/send-auth-sms/handler.ts";

const qaRoot = process.env.SMS_QA_ROOT
  ? resolve(process.env.SMS_QA_ROOT)
  : fileURLToPath(
      new URL("../supabase/functions/send-auth-sms/qa/", import.meta.url),
    );
const requireQa = createRequire(join(qaRoot, "package.json"));
let Webhook;
let OpenApiUtil;
try {
  ({ Webhook } = requireQa("standardwebhooks"));
  ({ OpenApiUtil } = requireQa("@alicloud/openapi-core"));
  assert.equal(requireQa("standardwebhooks/package.json").version, "1.1.1");
  assert.equal(
    requireQa("@alicloud/openapi-core/package.json").version,
    "1.0.8",
  );
  assert.equal(typeof OpenApiUtil.getAuthorization, "function");
} catch {
  throw new Error(
    "请先执行 pnpm --dir supabase/functions/send-auth-sms/qa install --frozen-lockfile --ignore-scripts，或将 SMS_QA_ROOT 指向已安装同版本依赖的隔离目录。",
  );
}

// All identities and keys in this script are deterministic local fixtures.
const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const oldSecret = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
const fixtureEnv = {
  SEND_SMS_HOOK_SECRET: `v1,${secret}`,
  ALIYUN_ACCESS_KEY_ID: "offline-access-id",
  ALIYUN_ACCESS_KEY_SECRET: "offline-access-secret",
  ALIYUN_SMS_SIGN_NAME: "离线测试签名",
  ALIYUN_SMS_TEMPLATE_CODE: "offline-template",
  SMS_OTP_TTL_SECONDS: "300",
  SUPABASE_URL: "https://offline.supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "offline-service-role-key",
};
const fixturePhone = "+8613800000000";
const payload = (overrides = {}) => ({
  user: { id: "offline-user", phone: fixturePhone },
  sms: { otp: "012345" },
  ...overrides,
});

function signedRequest(value = payload(), options = {}) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const timestamp = options.timestamp ?? new Date();
  const messageId = options.messageId ?? "offline-message";
  const signature = new Webhook(options.secret ?? secret).sign(
    messageId,
    timestamp,
    raw,
  );
  return new Request("https://hook.example.test/send-auth-sms", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": messageId,
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "webhook-signature": signature,
      ...options.headers,
    },
    body: options.body ?? raw,
  });
}

function memoryDedupe() {
  const records = new Map();
  let now = Date.now();
  return {
    records,
    advance(milliseconds) {
      now += milliseconds;
    },
    request(name, parameters) {
      const { p_digest: digest, p_claim_id: claimId } = parameters;
      const prior = records.get(digest);
      if (name === "claim_auth_sms") {
        if (prior && prior.until > now)
          return prior.state === "sent" ? "sent" : "blocked";
        records.set(digest, { claimId, state: "pending", until: now + 45000 });
        return "claimed";
      }
      if (
        !prior ||
        prior.claimId !== claimId ||
        prior.until <= now ||
        prior.state !== "pending"
      )
        return false;
      prior.state = parameters.p_sent ? "sent" : "unknown";
      return true;
    },
  };
}

function setup(options = {}) {
  const calls = [];
  const rpcCalls = [];
  const diagnostics = [];
  const store = options.store ?? memoryDedupe();
  const environment = { ...fixtureEnv, ...options.env };
  const handler = createSmsHandler({
    readEnv: (name) => environment[name],
    verifySignature(hookSecret, raw, headers) {
      new Webhook(hookSecret).verify(raw, headers, { jsonParse: false });
    },
    authorize:
      options.authorize ?? ((...args) => OpenApiUtil.getAuthorization(...args)),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === fixtureEnv.SUPABASE_URL) {
        const name = url.pathname.split("/").at(-1);
        const parameters = JSON.parse(init.body);
        rpcCalls.push({ name, parameters, init });
        assert.equal(init.headers.apikey, fixtureEnv.SUPABASE_SERVICE_ROLE_KEY);
        assert.equal(
          init.headers.authorization,
          `Bearer ${fixtureEnv.SUPABASE_SERVICE_ROLE_KEY}`,
        );
        return options.rpc
          ? options.rpc(name, parameters, store, init)
          : Response.json(store.request(name, parameters));
      }
      calls.push({ url, init });
      return options.fetch
        ? options.fetch(input, init)
        : Response.json({ Code: "OK", Success: true });
    },
    providerTimeoutMs: options.timeoutMs,
    claimTimeoutMs: options.claimTimeoutMs,
    rpcTimeoutMs: options.rpcTimeoutMs,
    hookTimeoutMs: options.hookTimeoutMs,
    onDiagnostic(event) {
      diagnostics.push(event);
      options.onDiagnostic?.(event);
    },
  });
  return { handler, calls, rpcCalls, store, diagnostics };
}

async function hookError(response, expected) {
  assert.equal(response.status, expected);
  const body = await response.json();
  assert.equal(body.error.http_code, expected);
  assert.equal(typeof body.error.message, "string");
  const serialized = JSON.stringify(body);
  for (const sensitive of [
    fixturePhone,
    "012345",
    "offline-access-secret",
    fixtureEnv.SUPABASE_SERVICE_ROLE_KEY,
  ])
    assert.equal(serialized.includes(sensitive), false);
}

function independentAuthorization(url, init) {
  const headers = init.headers;
  const names = Object.keys(headers)
    .filter(
      (name) =>
        name === "host" || name === "content-type" || name.startsWith("x-acs-"),
    )
    .sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${headers[name].trim()}\n`)
    .join("");
  const encode = (value) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  const canonicalQuery = [...url.searchParams]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join("&");
  const bodyHash = createHash("sha256")
    .update(init.body ?? "")
    .digest("hex");
  assert.equal(headers["x-acs-content-sha256"], bodyHash);
  const canonical = [
    "POST",
    "/",
    canonicalQuery,
    canonicalHeaders,
    names.join(";"),
    bodyHash,
  ].join("\n");
  const stringToSign = `ACS3-HMAC-SHA256\n${createHash("sha256").update(canonical).digest("hex")}`;
  const signature = createHmac("sha256", fixtureEnv.ALIYUN_ACCESS_KEY_SECRET)
    .update(stringToSign)
    .digest("hex");
  return `ACS3-HMAC-SHA256 Credential=${fixtureEnv.ALIYUN_ACCESS_KEY_ID},SignedHeaders=${names.join(";")},Signature=${signature}`;
}

test("real Standard Webhooks and Alibaba SDK send the exact Supabase OTP, including leading zero", async () => {
  const { handler, calls } = setup();
  const response = await handler(signedRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url.origin, "https://dypnsapi.aliyuncs.com");
  assert.equal(url.searchParams.get("PhoneNumber"), "13800000000");
  assert.equal(url.searchParams.get("CountryCode"), "86");
  assert.equal(
    url.searchParams.get("SignName"),
    fixtureEnv.ALIYUN_SMS_SIGN_NAME,
  );
  assert.equal(
    url.searchParams.get("TemplateCode"),
    fixtureEnv.ALIYUN_SMS_TEMPLATE_CODE,
  );
  assert.deepEqual(JSON.parse(url.searchParams.get("TemplateParam")), {
    code: "012345",
    min: "5",
  });
  assert.equal(url.searchParams.has("CodeType"), false);
  assert.equal(url.searchParams.get("ReturnVerifyCode"), "false");
  assert.equal(url.searchParams.get("AutoRetry"), "0");
  assert.equal(init.headers["x-acs-action"], "SendSmsVerifyCode");
  assert.equal(init.headers["x-acs-version"], "2017-05-25");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(init.body, undefined);
  assert.equal(init.headers.authorization, independentAuthorization(url, init));
});

test("SDK authorization matches Alibaba's published ACS3 fixture", () => {
  const hash =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const authorization = OpenApiUtil.getAuthorization(
    {
      method: "POST",
      pathname: "/",
      query: {
        ImageId: "win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd",
        RegionId: "cn-shanghai",
      },
      headers: {
        host: "ecs.cn-shanghai.aliyuncs.com",
        "x-acs-action": "RunInstances",
        "x-acs-content-sha256": hash,
        "x-acs-date": "2023-10-26T10:22:32Z",
        "x-acs-signature-nonce": "3156853299f313e23d1673dc12e1703d",
        "x-acs-version": "2014-05-26",
      },
    },
    "ACS3-HMAC-SHA256",
    hash,
    "YourAccessKeyId",
    "YourAccessKeySecret",
  );
  assert.ok(
    authorization.endsWith(
      "Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0",
    ),
  );
});

test("signed Supabase normalized numbers are accepted, and sms.phone is the destination for phone changes", async () => {
  const { handler, calls } = setup();
  const response = await handler(
    signedRequest(
      payload({
        user: { phone: "+8613900000000" },
        sms: { phone: "8613800000000", otp: "012345" },
      }),
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(calls[0].url.searchParams.get("PhoneNumber"), "13800000000");
});

test("hook key rotation accepts a valid secondary signature", async () => {
  const { handler, calls } = setup({
    env: { SEND_SMS_HOOK_SECRET: `v1,${oldSecret}|v1,${secret}` },
  });
  assert.equal((await handler(signedRequest())).status, 200);
  assert.equal(calls.length, 1);
});

for (const [name, options] of [
  ["wrong key", { secret: oldSecret }],
  ["expired signature", { timestamp: new Date(Date.now() - 301000) }],
  ["future signature", { timestamp: new Date(Date.now() + 301000) }],
  [
    "tampered body",
    { body: JSON.stringify(payload({ sms: { otp: "999999" } })) },
  ],
  ["tampered message ID", { headers: { "webhook-id": "tampered" } }],
  [
    "tampered timestamp",
    { headers: { "webhook-timestamp": `${Math.floor(Date.now() / 1000)}x` } },
  ],
  ["missing signature", { headers: { "webhook-signature": "" } }],
]) {
  test(`${name} is rejected before any provider request`, async () => {
    const { handler, calls } = setup();
    await hookError(await handler(signedRequest(payload(), options)), 401);
    assert.equal(calls.length, 0);
  });
}

test("unsigned and GET requests cannot send SMS", async () => {
  const { handler, calls } = setup();
  await hookError(await handler(new Request("https://hook.example.test")), 405);
  await hookError(
    await handler(
      new Request("https://hook.example.test", { method: "POST", body: "{}" }),
    ),
    401,
  );
  assert.equal(calls.length, 0);
});

test("unsupported phones and malformed OTPs do not contact the provider", async () => {
  for (const phone of [
    "13800000000",
    "+14155550000",
    "+85261234567",
    "+860100000000",
    " +8613800000000",
    "+86138000000000",
    null,
  ]) {
    const { handler, calls } = setup();
    await hookError(
      await handler(signedRequest(payload({ user: { phone } }))),
      400,
    );
    assert.equal(calls.length, 0);
  }
  for (const otp of [123456, "12345", "1234567", "12a456", " 123456", null]) {
    const { handler, calls } = setup();
    await hookError(
      await handler(signedRequest(payload({ sms: { otp } }))),
      400,
    );
    assert.equal(calls.length, 0);
  }
  const { handler, calls } = setup();
  await hookError(
    await handler(
      signedRequest(payload({ sms: { phone: "", otp: "012345" } })),
    ),
    400,
  );
  assert.equal(calls.length, 0);
});

test("signed malformed JSON and oversized bodies fail without delivery", async () => {
  const { handler, calls } = setup();
  await hookError(await handler(signedRequest("{")), 400);
  await hookError(await handler(signedRequest("x".repeat(32769))), 413);
  assert.equal(calls.length, 0);
});

test("missing server configuration fails closed", async () => {
  for (const name of [
    "SEND_SMS_HOOK_SECRET",
    "ALIYUN_ACCESS_KEY_ID",
    "ALIYUN_ACCESS_KEY_SECRET",
    "ALIYUN_SMS_SIGN_NAME",
    "ALIYUN_SMS_TEMPLATE_CODE",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]) {
    const { handler, calls, rpcCalls } = setup({ env: { [name]: undefined } });
    await hookError(await handler(signedRequest()), 503);
    assert.equal(calls.length, 0);
    assert.equal(rpcCalls.length, 0);
  }
  const { handler, calls } = setup({ env: { SMS_OTP_TTL_SECONDS: "invalid" } });
  await hookError(await handler(signedRequest()), 503);
  assert.equal(calls.length, 0);
});

for (const [name, provider] of [
  [
    "HTTP failure",
    async () => new Response("sensitive provider detail", { status: 429 }),
  ],
  [
    "business rejection",
    async () =>
      Response.json({
        Code: "BUSINESS_LIMIT_CONTROL",
        Success: false,
        Message: fixturePhone,
      }),
  ],
  [
    "success flag false",
    async () => Response.json({ Code: "OK", Success: false }),
  ],
  ["missing success flag", async () => Response.json({ Code: "OK" })],
  [
    "non-OK business code",
    async () => Response.json({ Code: "REJECTED", Success: true }),
  ],
  ["malformed response", async () => new Response("not JSON")],
  [
    "network exception",
    async () => {
      throw new Error(`${fixturePhone}:012345:offline-access-secret`);
    },
  ],
]) {
  test(`${name} returns a sanitized hook error rather than success`, async () => {
    const { handler, calls } = setup({ fetch: provider });
    await hookError(await handler(signedRequest()), 502);
    assert.equal(calls.length, 1);
  });
}

test("provider timeout aborts its request within the HTTP hook budget", async () => {
  let aborted = false;
  const { handler } = setup({
    timeoutMs: 15,
    fetch: async (_input, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("offline aborted"));
        });
      }),
  });
  await hookError(await handler(signedRequest()), 504);
  assert.equal(aborted, true);
});

test("a hung provider that ignores abort still cannot hold the hook open", async () => {
  const { handler } = setup({
    timeoutMs: 15,
    fetch: async () => new Promise(() => {}),
  });
  await hookError(await handler(signedRequest()), 504);
});

test("optional STS token participates in the actual SDK signature", async () => {
  const { handler, calls } = setup({
    env: { ALIYUN_SECURITY_TOKEN: "offline-sts-token" },
  });
  assert.equal((await handler(signedRequest())).status, 200);
  const { url, init } = calls[0];
  assert.equal(init.headers["x-acs-security-token"], "offline-sts-token");
  assert.ok(init.headers.authorization.includes("x-acs-security-token"));
  assert.equal(init.headers.authorization, independentAuthorization(url, init));
});

test("different webhook IDs with identical signed body share the durable HMAC claim", async () => {
  const { handler, calls, rpcCalls } = setup();
  assert.equal(
    (await handler(signedRequest(payload(), { messageId: "attempt-1" })))
      .status,
    200,
  );
  assert.equal(
    (await handler(signedRequest(payload(), { messageId: "attempt-2" })))
      .status,
    200,
  );
  assert.equal(calls.length, 1);
  const claims = rpcCalls.filter((call) => call.name === "claim_auth_sms");
  const expected = createHmac("sha256", fixtureEnv.SUPABASE_SERVICE_ROLE_KEY)
    .update(`send-auth-sms:v1\0${JSON.stringify(payload())}`)
    .digest("hex");
  assert.equal(claims.length, 2);
  assert.equal(claims[0].parameters.p_digest, expected);
  assert.equal(claims[1].parameters.p_digest, expected);
  assert.notEqual(
    claims[0].parameters.p_claim_id,
    claims[1].parameters.p_claim_id,
  );
  for (const call of rpcCalls) {
    const stored = JSON.stringify(call.parameters);
    assert.equal(stored.includes(fixturePhone), false);
    assert.equal(stored.includes("012345"), false);
    assert.equal(stored.includes(fixtureEnv.SUPABASE_SERVICE_ROLE_KEY), false);
  }
});

test("simultaneous requests contend on one claim and only one calls the SMS provider", async () => {
  let providerStarted;
  let releaseProvider;
  const started = new Promise((resolve) => {
    providerStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  const { handler, calls } = setup({
    fetch: async () => {
      providerStarted();
      await gate;
      return Response.json({ Code: "OK", Success: true });
    },
  });
  const one = handler(signedRequest(payload(), { messageId: "parallel-1" }));
  const two = handler(signedRequest(payload(), { messageId: "parallel-2" }));
  await started;
  await hookError(await Promise.race([one, two]), 422);
  releaseProvider();
  const responses = await Promise.all([one, two]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 422],
  );
  assert.equal(calls.length, 1);
});

test("an unknown provider outcome blocks a new webhook ID instead of charging again", async () => {
  const { handler, calls, store } = setup({
    fetch: async () => {
      throw new Error("connection lost after submission");
    },
  });
  await hookError(await handler(signedRequest()), 502);
  await hookError(
    await handler(signedRequest(payload(), { messageId: "after-disconnect" })),
    422,
  );
  assert.equal(calls.length, 1);
  assert.equal([...store.records.values()][0].state, "unknown");
});

test("late provider success after a timeout cannot turn the durable unknown state into sent", async () => {
  let lateSuccess;
  const { handler, calls, store } = setup({
    timeoutMs: 15,
    fetch: async () =>
      new Promise((resolve) => {
        lateSuccess = resolve;
      }),
  });
  await hookError(await handler(signedRequest()), 504);
  lateSuccess(Response.json({ Code: "OK", Success: true }));
  await new Promise(setImmediate);
  assert.equal([...store.records.values()][0].state, "unknown");
  await hookError(
    await handler(signedRequest(payload(), { messageId: "late-retry" })),
    422,
  );
  assert.equal(calls.length, 1);
});

test("claim network failure never reaches the provider, even if the claim committed", async () => {
  const { handler, calls } = setup({
    rpc: async (name, parameters, store) => {
      store.request(name, parameters);
      throw new Error("lost RPC response offline-service-role-key");
    },
  });
  await hookError(await handler(signedRequest()), 422);
  await hookError(
    await handler(signedRequest(payload(), { messageId: "claim-retry" })),
    422,
  );
  assert.equal(calls.length, 0);
});

test("unrecognized claim results fail closed", async () => {
  for (const result of [true, null, {}, [], "unexpected"]) {
    const { handler, calls } = setup({
      rpc: async () => Response.json(result),
    });
    await hookError(await handler(signedRequest()), 422);
    assert.equal(calls.length, 0);
  }
});

test("an uncertain successful-send finalization does not report success or resend", async () => {
  const { handler, calls, store } = setup({
    rpc: async (name, parameters, records) => {
      if (name === "finish_auth_sms") throw new Error("lost finalize response");
      return Response.json(records.request(name, parameters));
    },
  });
  await hookError(await handler(signedRequest()), 422);
  await hookError(
    await handler(signedRequest(payload(), { messageId: "finalize-retry" })),
    422,
  );
  assert.equal(calls.length, 1);
  assert.equal([...store.records.values()][0].state, "pending");
});

test("a committed sent record survives a lost finalize response and answers the retry without SMS", async () => {
  const { handler, calls } = setup({
    rpc: async (name, parameters, records) => {
      const result = records.request(name, parameters);
      if (name === "finish_auth_sms")
        throw new Error("response lost after commit");
      return Response.json(result);
    },
  });
  await hookError(await handler(signedRequest()), 422);
  assert.equal(
    (await handler(signedRequest(payload(), { messageId: "committed-retry" })))
      .status,
    200,
  );
  assert.equal(calls.length, 1);
});

test("finalization requires an exact true CAS result", async () => {
  for (const result of [false, null, "true", {}, []]) {
    const { handler, calls } = setup({
      rpc: async (name, parameters, records) =>
        Response.json(
          name === "claim_auth_sms"
            ? records.request(name, parameters)
            : result,
        ),
    });
    await hookError(await handler(signedRequest()), 422);
    assert.equal(calls.length, 1);
  }
});

test("after sixty seconds the same body may start a new lease and incur a new send", async () => {
  const { handler, calls, store } = setup();
  assert.equal((await handler(signedRequest())).status, 200);
  store.advance(60000);
  assert.equal(
    (await handler(signedRequest(payload(), { messageId: "user-resend" })))
      .status,
    200,
  );
  assert.equal(calls.length, 2);
});

test("a late first lease cannot finalize a newer successful lease", async () => {
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });
  let sends = 0;
  const { handler, calls, store } = setup({
    fetch: async () => {
      if (++sends === 1) {
        firstStarted();
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Response.json({ Code: "OK", Success: true });
    },
  });
  const first = handler(signedRequest());
  await started;
  store.advance(60000);
  assert.equal(
    (await handler(signedRequest(payload(), { messageId: "new-lease" })))
      .status,
    200,
  );
  const newerId = [...store.records.values()][0].claimId;
  releaseFirst();
  await hookError(await first, 422);
  assert.equal([...store.records.values()][0].claimId, newerId);
  assert.equal([...store.records.values()][0].state, "sent");
  assert.equal(calls.length, 2);
});

test("invalid signed payloads never claim or persist their content", async () => {
  const { handler, calls, rpcCalls } = setup();
  await hookError(
    await handler(signedRequest(payload({ sms: { otp: "invalid" } }))),
    400,
  );
  assert.equal(rpcCalls.length, 0);
  assert.equal(calls.length, 0);
});

test("slow claims consume the overall budget and cannot start an unfinalizable send", async () => {
  const { handler, calls } = setup({
    hookTimeoutMs: 70,
    rpcTimeoutMs: 50,
    rpc: async (name, parameters, records) => {
      if (name === "claim_auth_sms")
        await new Promise((resolve) => setTimeout(resolve, 35));
      return Response.json(records.request(name, parameters));
    },
  });
  await hookError(await handler(signedRequest()), 422);
  assert.equal(calls.length, 0);
});

test("a hung claim is bounded and never invokes the SMS provider", async () => {
  const { handler, calls } = setup({
    rpcTimeoutMs: 15,
    rpc: async () => new Promise(() => {}),
  });
  await hookError(await handler(signedRequest()), 422);
  assert.equal(calls.length, 0);
});

test("a cold claim above 600ms can finish without changing the send confirmation", async () => {
  const { handler, calls, store } = setup({
    rpc: async (name, parameters, records) => {
      if (name === "claim_auth_sms")
        await new Promise((resolve) => setTimeout(resolve, 750));
      return Response.json(records.request(name, parameters));
    },
  });
  assert.equal((await handler(signedRequest())).status, 200);
  assert.equal(calls.length, 1);
  assert.equal([...store.records.values()][0].state, "sent");
});

test("default claim budget accepts a 1200ms cold response and sends exactly once", async () => {
  const { handler, calls, rpcCalls, store, diagnostics } = setup({
    rpc: async (name, parameters, records) => {
      if (name === "claim_auth_sms")
        await new Promise((resolve) => setTimeout(resolve, 1200));
      return Response.json(records.request(name, parameters));
    },
  });
  assert.equal((await handler(signedRequest())).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(rpcCalls.filter(call => call.name === "claim_auth_sms").length, 1);
  assert.deepEqual(rpcCalls.filter(call => call.name === "finish_auth_sms")
    .map(call => call.parameters.p_sent), [true]);
  assert.equal([...store.records.values()][0].state, "sent");
  assert.deepEqual(diagnostics, []);
});

test("default claim cap aborts without retry or SMS even if its commit arrives later", async () => {
  let commitLateClaim;
  let firstClaim = true;
  let aborted = false;
  const { handler, calls, rpcCalls, store, diagnostics } = setup({
    rpc: async (name, parameters, records, init) => {
      if (name === "claim_auth_sms" && firstClaim) {
        firstClaim = false;
        init.signal.addEventListener("abort", () => { aborted = true; });
        return new Promise((resolve) => {
          commitLateClaim = () => resolve(Response.json(records.request(name, parameters)));
        });
      }
      return Response.json(records.request(name, parameters));
    },
  });
  await hookError(await handler(signedRequest()), 422);
  assert.equal(aborted, true);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, "claim_auth_sms");
  assert.equal(calls.length, 0);
  assert.equal(store.records.size, 0);
  assert.deepEqual(diagnostics, [{ stage: "claim", reason: "timeout" }]);

  // A cancelled HTTP response may still commit in Postgres after the cap.
  // Resolving that promise cannot revive the already rejected send path.
  commitLateClaim();
  await new Promise(setImmediate);
  assert.equal([...store.records.values()][0].state, "pending");
  assert.equal(calls.length, 0);
  await hookError(await handler(signedRequest(payload(), {
    messageId: "default-late-claim-retry",
  })), 422);
  assert.equal(calls.length, 0);
  assert.equal(rpcCalls.filter(call => call.name === "claim_auth_sms").length, 2);
  assert.equal(rpcCalls.some(call => call.name === "finish_auth_sms"), false);
});

test("provider may use remaining hook budget beyond the old 2800ms cap", async () => {
  const { handler, calls, store } = setup({
    fetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 3100));
      return Response.json({ Code: "OK", Success: true });
    },
  });
  assert.equal((await handler(signedRequest())).status, 200);
  assert.equal(calls.length, 1);
  assert.equal([...store.records.values()][0].state, "sent");
});

test("claim timeout allowance does not consume the independent finalization reserve", async () => {
  const { handler, calls } = setup({
    hookTimeoutMs: 180,
    claimTimeoutMs: 120,
    rpcTimeoutMs: 30,
    rpc: async (name, parameters, records) => {
      if (name === "claim_auth_sms")
        await new Promise((resolve) => setTimeout(resolve, 65));
      return Response.json(records.request(name, parameters));
    },
  });
  assert.equal((await handler(signedRequest())).status, 200);
  assert.equal(calls.length, 1);
});

test("provider response-body stalls are bounded, even when the stream ignores abort", async () => {
  let bodyController;
  let aborted = false;
  const encoder = new TextEncoder();
  const { handler, calls, rpcCalls, store } = setup({
    timeoutMs: 15,
    fetch: async (_input, init) => {
      init.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            bodyController = controller;
            controller.enqueue(encoder.encode('{"Code":"OK","Success":'));
          },
        }),
      );
    },
  });
  await hookError(await handler(signedRequest()), 504);
  assert.equal(aborted, true);
  assert.equal([...store.records.values()][0].state, "unknown");
  assert.deepEqual(
    rpcCalls
      .filter((call) => call.name === "finish_auth_sms")
      .map((call) => call.parameters.p_sent),
    [false],
  );

  // The response headers arrived before the timeout. Completing JSON later
  // must not resume the handler's successful-send finalization.
  bodyController.enqueue(encoder.encode("true}"));
  bodyController.close();
  await new Promise(setImmediate);
  assert.equal([...store.records.values()][0].state, "unknown");
  await hookError(
    await handler(signedRequest(payload(), { messageId: "body-stream-retry" })),
    422,
  );
  assert.equal(calls.length, 1);
});

test("a claim committed after its RPC timeout cannot resume SMS delivery", async () => {
  let commitLateClaim;
  let delayFirstClaim = true;
  let aborted = false;
  const { handler, calls, rpcCalls, store } = setup({
    rpcTimeoutMs: 15,
    rpc: async (name, parameters, records, init) => {
      if (name === "claim_auth_sms" && delayFirstClaim) {
        delayFirstClaim = false;
        init.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise((resolve) => {
          commitLateClaim = () =>
            resolve(Response.json(records.request(name, parameters)));
        });
      }
      return Response.json(records.request(name, parameters));
    },
  });
  await hookError(await handler(signedRequest()), 422);
  assert.equal(aborted, true);
  assert.equal(store.records.size, 0);
  assert.equal(calls.length, 0);

  // HTTP cancellation does not prove that the database transaction stopped.
  commitLateClaim();
  await new Promise(setImmediate);
  assert.equal([...store.records.values()][0].state, "pending");
  await hookError(
    await handler(signedRequest(payload(), { messageId: "late-claim-retry" })),
    422,
  );
  assert.equal(calls.length, 0);
  assert.equal(
    rpcCalls.some((call) => call.name === "finish_auth_sms"),
    false,
  );
});

test("a finalize committed after its RPC timeout answers only later retries as sent", async () => {
  let commitLateFinalize;
  let aborted = false;
  const { handler, calls, rpcCalls, store } = setup({
    rpcTimeoutMs: 15,
    rpc: async (name, parameters, records, init) => {
      if (name === "finish_auth_sms") {
        init.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise((resolve) => {
          commitLateFinalize = () =>
            resolve(Response.json(records.request(name, parameters)));
        });
      }
      return Response.json(records.request(name, parameters));
    },
  });
  const timedOut = await handler(signedRequest());
  await hookError(timedOut, 422);
  assert.equal(aborted, true);
  assert.equal([...store.records.values()][0].state, "pending");
  await hookError(
    await handler(
      signedRequest(payload(), { messageId: "pending-finalize-retry" }),
    ),
    422,
  );
  assert.equal(calls.length, 1);

  commitLateFinalize();
  await new Promise(setImmediate);
  assert.equal(timedOut.status, 422);
  assert.equal([...store.records.values()][0].state, "sent");
  const retry = await handler(
    signedRequest(payload(), { messageId: "late-finalize-retry" }),
  );
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), {});
  assert.equal(calls.length, 1);
  assert.equal(
    rpcCalls.filter((call) => call.name === "finish_auth_sms").length,
    1,
  );
});

function safeDiagnostics(diagnostics) {
  for (const event of diagnostics) {
    for (const name of Object.keys(event))
      assert.ok(
        [
          "stage",
          "reason",
          "http_status",
          "provider_code",
          "transport_kind",
        ].includes(name),
      );
    if ("transport_kind" in event)
      assert.ok(
        ["dns", "tls", "connect", "redirect", "unknown"].includes(
          event.transport_kind,
        ),
      );
    if ("http_status" in event) {
      assert.equal(Number.isInteger(event.http_status), true);
      assert.ok(event.http_status >= 100 && event.http_status <= 599);
    }
  }
  const serialized = JSON.stringify(diagnostics);
  for (const privateValue of [
    fixturePhone,
    "13800000000",
    "012345",
    "offline-access-id",
    "offline-access-secret",
    "offline-service-role-key",
    secret,
    "offline-user",
    "private-message",
    "private-request-id",
    "https://",
  ])
    assert.equal(
      serialized.includes(privateValue),
      false,
      "diagnostics must contain no private values",
    );
}

test("provider diagnostics expose only exact allowlisted business codes, HTTP status and fixed phase", async () => {
  for (const code of [
    "InvalidAccessKeyId.NotFound",
    "SignatureDoesNotMatch",
    "isv.RAM_PERMISSION_DENY",
    "isv.OUT_OF_SERVICE",
    "EntityNotExist.SmsTemplateCode",
    "EntityNotExist.SmsSignName",
    "BUSINESS_LIMIT_CONTROL",
    "FUNCTION_NOT_OPENED",
  ]) {
    const { handler, diagnostics, calls } = setup({
      fetch: async () =>
        Response.json({
          Code: code,
          Success: false,
          Message: `private-message:${fixturePhone}:012345`,
          RequestId: "private-request-id",
          AccessDeniedDetail: fixtureEnv.ALIYUN_ACCESS_KEY_SECRET,
          Model: { VerifyCode: "012345", PhoneNumber: fixturePhone },
        }),
    });
    await hookError(await handler(signedRequest()), 502);
    assert.equal(calls.length, 1);
    assert.deepEqual(diagnostics, [
      {
        stage: "provider",
        reason: "rejected",
        http_status: 200,
        provider_code: code,
      },
    ]);
    safeDiagnostics(diagnostics);
  }
});

test("non-2xx provider JSON yields only the allowlisted Code and keeps the existing error response", async () => {
  const { handler, diagnostics, store } = setup({
    fetch: async () =>
      Response.json(
        {
          Code: "InvalidAccessKeyId.NotFound",
          Message: `private-message:${fixturePhone}:012345`,
          AccessDeniedDetail: fixtureEnv.ALIYUN_ACCESS_KEY_SECRET,
        },
        { status: 403 },
      ),
  });
  await hookError(await handler(signedRequest()), 502);
  assert.deepEqual(diagnostics, [
    {
      stage: "provider",
      reason: "http_error",
      http_status: 403,
      provider_code: "InvalidAccessKeyId.NotFound",
    },
  ]);
  assert.equal([...store.records.values()][0].state, "unknown");
  safeDiagnostics(diagnostics);
});

test("arbitrary or malicious provider Code values are replaced rather than logged", async () => {
  for (const code of [
    fixturePhone,
    "012345",
    fixtureEnv.ALIYUN_ACCESS_KEY_SECRET,
    "InvalidAccessKeyId.NotFound\n012345",
    "SignatureDoesNotMatch_13800000000",
    "__proto__",
    "constructor",
    "UNKNOWN_FUTURE_CODE",
    123456,
    null,
    { private: fixturePhone },
    ["012345"],
  ]) {
    for (const status of [200, 400]) {
      const { handler, diagnostics } = setup({
        fetch: async () =>
          Response.json(
            {
              Code: code,
              Success: false,
              Message: `private-message:${fixturePhone}:012345`,
            },
            { status },
          ),
      });
      await hookError(await handler(signedRequest()), 502);
      assert.equal(diagnostics[0].provider_code, "OTHER");
      safeDiagnostics(diagnostics);
    }
  }
});

test("provider transport and malformed JSON errors emit fixed diagnostics without exception contents", async () => {
  for (const [provider, reason, http] of [
    [
      async () => {
        throw new Error(
          `private-message:${fixturePhone}:012345:offline-access-secret`,
        );
      },
      "transport_error",
      undefined,
    ],
    [
      async () => new Response(`private-message:${fixturePhone}:012345`),
      "invalid_response",
      200,
    ],
  ]) {
    const { handler, diagnostics } = setup({ fetch: provider });
    await hookError(await handler(signedRequest()), 502);
    assert.deepEqual(diagnostics, [
      {
        stage: "provider",
        reason,
        ...(http === undefined ? {} : { http_status: http }),
        provider_code: "OTHER",
        ...(reason === "transport_error" ? { transport_kind: "unknown" } : {}),
      },
    ]);
    safeDiagnostics(diagnostics);
  }
});

test("provider timeout diagnostics do not change timeout or durable unknown semantics", async () => {
  const { handler, diagnostics, store } = setup({
    timeoutMs: 15,
    fetch: async () => new Promise(() => {}),
  });
  await hookError(await handler(signedRequest()), 504);
  assert.deepEqual(diagnostics, [
    { stage: "provider", reason: "timeout", provider_code: "OTHER" },
  ]);
  assert.equal([...store.records.values()][0].state, "unknown");
  safeDiagnostics(diagnostics);
});

test("a non-2xx diagnostic body stall stays within the provider budget and preserves HTTP failure semantics", async () => {
  let finishBody;
  const { handler, diagnostics } = setup({
    timeoutMs: 15,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            finishBody = controller;
          },
        }),
        { status: 403 },
      ),
  });
  await hookError(await handler(signedRequest()), 502);
  assert.deepEqual(diagnostics, [
    {
      stage: "provider",
      reason: "timeout",
      http_status: 403,
      provider_code: "OTHER",
    },
  ]);
  finishBody.close();
  safeDiagnostics(diagnostics);
});

test("database failures identify claim, successful-send finalization and unknown finalization without SQL data", async () => {
  for (const stage of ["claim", "finish_sent", "finish_unknown"]) {
    const { handler, diagnostics, calls } = setup({
      fetch:
        stage === "finish_unknown"
          ? async () =>
              Response.json({ Code: "BUSINESS_LIMIT_CONTROL", Success: false })
          : undefined,
      rpc: async (name, parameters, store) => {
        const current =
          name === "claim_auth_sms"
            ? "claim"
            : parameters.p_sent
              ? "finish_sent"
              : "finish_unknown";
        if (current === stage)
          return Response.json(
            {
              message: `private-message:${fixturePhone}:012345`,
              code: "offline-service-role-key",
            },
            { status: 503 },
          );
        return Response.json(store.request(name, parameters));
      },
    });
    await hookError(
      await handler(signedRequest()),
      stage === "finish_unknown" ? 502 : 422,
    );
    const databaseEvents = diagnostics.filter(
      (event) => event.stage !== "provider",
    );
    assert.deepEqual(databaseEvents, [
      { stage, reason: "http_error", http_status: 503 },
    ]);
    assert.equal(calls.length, stage === "claim" ? 0 : 1);
    safeDiagnostics(diagnostics);
  }
});

test("database transport, parse, and timeout failures produce only fixed diagnostics", async () => {
  for (const [rpc, reason, http] of [
    [
      async () => {
        throw new Error(
          `private-message:${fixturePhone}:012345:offline-service-role-key`,
        );
      },
      "transport_error",
      undefined,
    ],
    [
      async () => new Response(`private-message:${fixturePhone}`),
      "invalid_response",
      200,
    ],
    [async () => new Promise(() => {}), "timeout", undefined],
  ]) {
    const { handler, diagnostics, calls } = setup({ rpcTimeoutMs: 15, rpc });
    await hookError(await handler(signedRequest()), 422);
    assert.deepEqual(diagnostics, [
      {
        stage: "claim",
        reason,
        ...(http === undefined ? {} : { http_status: http }),
        ...(reason === "transport_error" ? { transport_kind: "unknown" } : {}),
      },
    ]);
    assert.equal(calls.length, 0);
    safeDiagnostics(diagnostics);
  }
});

test("diagnostic callback failures cannot alter successful delivery or failure responses", async () => {
  const onDiagnostic = () => {
    throw new Error("private-message:012345");
  };
  const success = setup({ onDiagnostic });
  assert.equal((await success.handler(signedRequest())).status, 200);
  assert.deepEqual(success.diagnostics, []);
  const failure = setup({
    onDiagnostic,
    fetch: async () =>
      Response.json({ Code: "BUSINESS_LIMIT_CONTROL", Success: false }),
  });
  await hookError(await failure.handler(signedRequest()), 502);
  assert.equal([...failure.store.records.values()][0].state, "unknown");
  safeDiagnostics(failure.diagnostics);
});

test("provider signing exceptions cannot leak credentials or alter the existing 500 failure", async () => {
  const { handler, diagnostics, calls, store } = setup({
    authorize() {
      throw new Error(
        `private-message:${fixturePhone}:012345:offline-access-secret`,
      );
    },
  });
  await hookError(await handler(signedRequest()), 500);
  assert.equal(calls.length, 0);
  assert.equal([...store.records.values()][0].state, "unknown");
  assert.deepEqual(diagnostics, [
    { stage: "provider", reason: "signing_error" },
  ]);
  safeDiagnostics(diagnostics);
});

test("official SDK trims pasted AccessKey boundary whitespace before signing and actual Request construction", async () => {
  for (const padding of [" ", "\n", "\r\n\t"]) {
    const { handler, calls, diagnostics } = setup({
      env: {
        ALIYUN_ACCESS_KEY_ID: `${padding}${fixtureEnv.ALIYUN_ACCESS_KEY_ID}${padding}`,
        ALIYUN_ACCESS_KEY_SECRET: `${padding}${fixtureEnv.ALIYUN_ACCESS_KEY_SECRET}${padding}`,
      },
    });
    assert.equal((await handler(signedRequest())).status, 200);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].init.headers.authorization,
      independentAuthorization(calls[0].url, calls[0].init),
    );
    assert.doesNotThrow(() => new Request(calls[0].url, calls[0].init));
    assert.deepEqual(diagnostics, []);
  }
});

test("other server parameters trim boundary whitespace without changing values or retry policy", async () => {
  const env = Object.fromEntries(
    Object.entries(fixtureEnv).map(([name, value]) => [
      name,
      ` \r\n${value}\t `,
    ]),
  );
  env.ALIYUN_SECURITY_TOKEN = " \r\noffline-sts-token\t ";
  const { handler, calls, diagnostics } = setup({ env });
  assert.equal((await handler(signedRequest())).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url.searchParams.get("SignName"),
    fixtureEnv.ALIYUN_SMS_SIGN_NAME,
  );
  assert.equal(
    calls[0].url.searchParams.get("TemplateCode"),
    fixtureEnv.ALIYUN_SMS_TEMPLATE_CODE,
  );
  assert.equal(calls[0].url.searchParams.get("AutoRetry"), "0");
  assert.equal(
    calls[0].init.headers["x-acs-security-token"],
    "offline-sts-token",
  );
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(diagnostics, []);
});

test("invalid Authorization or STS header construction fails before fetch without exposing header contents", async () => {
  for (const env of [
    { ALIYUN_ACCESS_KEY_ID: "offline\naccess-id" },
    { ALIYUN_ACCESS_KEY_ID: "离线占位" },
    { ALIYUN_SECURITY_TOKEN: "offline\nsecurity-token" },
  ]) {
    const { handler, calls, diagnostics, store } = setup({ env });
    await hookError(await handler(signedRequest()), 502);
    assert.equal(calls.length, 0);
    assert.equal([...store.records.values()][0].state, "unknown");
    assert.deepEqual(diagnostics, [
      { stage: "provider", reason: "invalid_request", provider_code: "OTHER" },
    ]);
    safeDiagnostics(diagnostics);
    await hookError(
      await handler(
        signedRequest(payload(), { messageId: "invalid-header-retry" }),
      ),
      422,
    );
    assert.equal(calls.length, 0);
  }
});

test("transport exceptions map to fixed DNS TLS connection redirect or unknown categories", async () => {
  const privateDetail = `private-message:${fixturePhone}:012345:offline-access-secret`;
  for (const [kind, failure] of [
    [
      "dns",
      new TypeError("error sending request", {
        cause: new Error(
          `dns error: failed to lookup address ${privateDetail}`,
        ),
      }),
    ],
    [
      "tls",
      new TypeError(`invalid peer certificate: UnknownIssuer ${privateDetail}`),
    ],
    [
      "connect",
      new TypeError(`tcp connect error: connection refused ${privateDetail}`),
    ],
    [
      "redirect",
      new TypeError(
        `Encountered redirect while redirect mode is set to 'error' ${privateDetail}`,
      ),
    ],
    ["unknown", new Error(privateDetail)],
    ["unknown", { name: "dns", message: privateDetail }],
  ]) {
    const { handler, diagnostics, calls, store } = setup({
      fetch: async () => {
        throw failure;
      },
    });
    await hookError(await handler(signedRequest()), 502);
    assert.equal(calls.length, 1);
    assert.equal([...store.records.values()][0].state, "unknown");
    assert.deepEqual(diagnostics, [
      {
        stage: "provider",
        reason: "transport_error",
        provider_code: "OTHER",
        transport_kind: kind,
      },
    ]);
    safeDiagnostics(diagnostics);
  }
});

test("hostile or cyclic error causes remain bounded and never escape diagnostics", async () => {
  const failures = [new Error("private-message"), new Error("private-message")];
  failures[0].cause = failures[0];
  Object.defineProperty(failures[1], "cause", {
    get() {
      throw new Error("private-message:012345");
    },
  });
  for (const failure of failures) {
    const { handler, diagnostics } = setup({
      fetch: async () => {
        throw failure;
      },
    });
    await hookError(await handler(signedRequest()), 502);
    assert.equal(diagnostics[0].transport_kind, "unknown");
    safeDiagnostics(diagnostics);
  }
});
