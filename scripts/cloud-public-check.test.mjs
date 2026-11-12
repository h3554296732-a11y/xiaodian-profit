import test from "node:test";
import assert from "node:assert/strict";
import { configuration, runPublicChecks } from "./cloud-public-check.mjs";

const key = "sb_publishable_offline_mock_only";
const proxyOrigin = "https://api.lirunben.cn";
const directOrigin = "https://nporrbvnaezafvryjqao.supabase.co";
const siteOrigin = "https://lirunben.cn";
const tables = ["shops", "products", "sales", "sale_items", "expenses"];
const environment = (origin = proxyOrigin) => ({
  NEXT_PUBLIC_SUPABASE_URL: origin,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key,
});
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...headers },
});

function proxyFixture(override) {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    assert.equal(url.origin, proxyOrigin);
    const custom = override?.(url, options);
    if (custom) return custom;
    if (options.headers.Origin === "https://other.example")
      return json(403, { error: "origin_not_allowed" }, { "access-control-allow-origin": "https://other.example" });
    if (options.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      "access-control-allow-origin": siteOrigin,
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": options.headers["Access-Control-Request-Headers"],
    } });
    if (url.pathname === "/healthz") return json(200, { ok: true, version: "lirunben-supabase-proxy-v1" });
    if (url.pathname === "/auth/v1/user") return json(401, { code: "bad_jwt" });
    if (tables.some(table => url.pathname === `/rest/v1/${table}`)) return json(401, { code: "42501" });
    return json(404, { error: "route_not_allowed" });
  };
  return { calls, fetchImpl };
}

test("configuration permits only the two exact fixed HTTPS origins and modern public key shape", async () => {
  for (const origin of [proxyOrigin, directOrigin]) {
    for (const value of [origin, `${origin}/`]) assert.equal(configuration(environment(value)).origin, origin);
  }
  const invalidOrigins = [
    "https://other.example", "http://api.lirunben.cn", `${proxyOrigin}:443`, `${proxyOrigin}:8443`,
    `${proxyOrigin}/account`, `${proxyOrigin}/x/..`, `${proxyOrigin}?x=1`, `${proxyOrigin}#x`,
    "https://user:password@api.lirunben.cn", "https://@api.lirunben.cn",
    "https://api.lirunben.cn.evil.test", ` ${proxyOrigin}`, `${proxyOrigin}\n`, undefined,
  ];
  let networkCalls = 0;
  for (const origin of invalidOrigins) await assert.rejects(runPublicChecks({
    environment: { ...environment(), NEXT_PUBLIC_SUPABASE_URL: origin },
    fetchImpl: async () => { networkCalls += 1; assert.fail("invalid origin must not receive a key"); },
  }));
  for (const bad of ["sb_secret_mock", "legacy.jwt.mock", "sb_publishable_", "sb_publishable_invalid key", undefined])
    assert.throws(() => configuration({ ...environment(), NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: bad }));
  assert.equal(networkCalls, 0);
});

test("proxy mode uses only fixed GET/OPTIONS paths and no user JWT, login, SMS or write RPC", async () => {
  const f = proxyFixture();
  const report = await runPublicChecks({ environment: environment(), fetchImpl: f.fetchImpl });
  assert.equal(report.mode, "proxy");
  assert.equal(report.result.length, 12);
  assert.ok(report.result.every(entry => entry.passed));
  assert.equal(f.calls.length, 12);
  for (const { url, options } of f.calls) {
    assert.ok(["GET", "OPTIONS"].includes(options.method));
    assert.equal(options.body, undefined);
    const headers = new Headers(options.headers);
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("cookie"), false);
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    if (tables.some(table => url.pathname === `/rest/v1/${table}`)) {
      assert.equal(url.search, "?select=*&limit=1");
      assert.equal(headers.get("apikey"), key);
      assert.equal(headers.get("origin"), siteOrigin);
    }
    if (url.pathname === "/auth/v1/otp") assert.equal(options.method, "OPTIONS");
    if (options.method === "OPTIONS" || url.pathname === "/healthz") assert.equal(headers.has("apikey"), false);
  }
});

test("public audit runs one request at a time and reports 429 without retrying", async () => {
  const f = proxyFixture(url => url.pathname === "/rest/v1/products"
    ? json(429, { error: "mock_concurrency_limit" }) : undefined);
  let active = 0, maximum = 0;
  const report = await runPublicChecks({ environment: environment(), fetchImpl: async (input, options) => {
    active += 1;
    maximum = Math.max(maximum, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 5));
      return await f.fetchImpl(input, options);
    } finally { active -= 1; }
  } });
  assert.equal(maximum, 1);
  assert.equal(active, 0);
  assert.equal(f.calls.length, 12);
  assert.equal(f.calls.filter(call => call.url.pathname === "/rest/v1/products").length, 1);
  assert.equal(report.result.filter(entry => !entry.passed).length, 1);
  assert.equal(report.result.find(entry => entry.label === "匿名 SELECT public.products").passed, false);
});

test("proxy accepts empty anonymous table results but never mislabels 404, invalid keys or exposed rows as RLS success", async () => {
  const empty = proxyFixture(url => url.pathname === "/rest/v1/shops" ? json(200, []) : undefined);
  assert.ok((await runPublicChecks({ environment: environment(), fetchImpl: empty.fetchImpl })).result.every(entry => entry.passed));
  for (const response of [
    () => json(404, { error: "route_not_allowed" }),
    () => json(401, { code: "invalid_api_key" }),
    () => json(200, [{ id: "private-row-must-not-be-printed" }]),
    () => new Response("private-non-json-response", { status: 403 }),
  ]) {
    const f = proxyFixture(url => url.pathname === "/rest/v1/shops" ? response() : undefined);
    const report = await runPublicChecks({ environment: environment(), fetchImpl: f.fetchImpl });
    const entry = report.result.find(item => item.label === "匿名 SELECT public.shops");
    assert.equal(entry.passed, false);
    assert.ok(!JSON.stringify(report).includes("private-row-must-not-be-printed"));
    assert.ok(!JSON.stringify(report).includes("private-non-json-response"));
    assert.equal(report.result.filter(item => !item.passed).length, 1);
  }
});

test("proxy health, preflight, Origin rejection, user authentication and disabled-route mismatches each fail", async () => {
  const cases = [
    (url, options) => url.pathname === "/healthz" && options.headers.Origin === siteOrigin
      ? json(200, { ok: true, version: "some-other-service" }) : undefined,
    (_url, options) => options.method === "OPTIONS" ? new Response(null, { status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-methods": "POST",
      "access-control-allow-headers": options.headers["Access-Control-Request-Headers"],
    } }) : undefined,
    (_url, options) => options.method === "OPTIONS" ? new Response(null, { status: 204, headers: {
      "access-control-allow-origin": siteOrigin, "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type",
    } }) : undefined,
    (_url, options) => options.headers.Origin === "https://other.example" ? json(200, { ok: true }) : undefined,
    url => url.pathname === "/auth/v1/user" ? json(403, { code: "no_access" }) : undefined,
    url => url.pathname === "/auth/v1/settings" ? json(404, { code: "not_a_proxy_rejection" }) : undefined,
  ];
  for (const override of cases) {
    const f = proxyFixture(override);
    const report = await runPublicChecks({ environment: environment(), fetchImpl: f.fetchImpl });
    assert.equal(report.result.filter(entry => !entry.passed).length, 1);
  }
});

test("direct mode retains the existing anonymous tables, guarded RPC and Auth settings audit", async () => {
  const calls = [];
  const report = await runPublicChecks({ environment: environment(directOrigin), fetchImpl: async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    assert.equal(url.origin, directOrigin);
    if (url.pathname === "/auth/v1/settings") return json(200, {
      external: { email: true }, disable_signup: false, mailer_autoconfirm: false,
    });
    return json(401, { code: "42501" });
  } });
  assert.equal(report.mode, "direct");
  assert.equal(report.result.length, 10);
  assert.ok(report.result.every(entry => entry.passed));
  assert.equal(calls.filter(call => call.options.method === "POST").length, 4);
  for (const { url, options } of calls) {
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.ok(url.pathname.startsWith("/rest/v1/rpc/"));
      assert.ok(body.p_id === "00000000-0000-0000-0000-000000000000"
        || body.p_digest === "invalid-security-probe");
    } else if (url.pathname.startsWith("/rest/v1/")) assert.equal(url.search, "?select=id&limit=1");
  }
});
