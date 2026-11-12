/**
 * Anonymous checks for the fixed Supabase project or its fixed public FC proxy.
 * Run: node --env-file=.env.local scripts/cloud-public-check.mjs
 * Only NEXT_PUBLIC_* URL/publishable key are read. No account/JWT or admin key is used.
 * Proxy mode uses only GET/OPTIONS. Direct mode retains non-persistable RPC probes.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const expectedProject = "nporrbvnaezafvryjqao";
const directOrigin = `https://${expectedProject}.supabase.co`;
const proxyOrigin = "https://api.lirunben.cn";
const siteOrigin = "https://lirunben.cn";
const proxyVersion = "lirunben-supabase-proxy-v1";
const preflightHeaders = ["apikey", "authorization", "content-type", "x-client-info", "x-supabase-api-version"];
const tables = ["shops", "products", "sales", "sale_items", "expenses"];
const nilUuid = "00000000-0000-0000-0000-000000000000";

export function configuration(environment = process.env) {
  const rawUrl = environment.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  assert.ok(rawUrl, "缺少 NEXT_PUBLIC_SUPABASE_URL。");
  assert.ok(
    typeof publishableKey === "string" && /^sb_publishable_[A-Za-z0-9_-]{1,200}$/.test(publishableKey),
    "仅允许 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY 中的公开 publishable key。",
  );
  // Compare the original string too: URL normalizes :443, dot paths and whitespace.
  // No port, credentials, non-root path, query or fragment is accepted, even if
  // normalization would turn one into an allowed origin.
  const origin = [directOrigin, proxyOrigin].find(allowed => rawUrl === allowed || rawUrl === `${allowed}/`);
  assert.ok(
    origin,
    "只允许本项目的固定 HTTPS 原站或 API 域名，不能包含端口、路径、凭据、查询参数或片段。",
  );
  return { origin, publishableKey, mode: origin === proxyOrigin ? "proxy" : "direct" };
}

function errorCode(body) {
  const code = body && !Array.isArray(body) && typeof body === "object" ? body.code : null;
  return typeof code === "string" && /^[A-Z0-9_]{1,30}$/.test(code) ? code : "未提供";
}

function tableRejection(status, json) {
  if (status === 200 && Array.isArray(json) && json.length === 0) {
    return "HTTP 200，返回空数组；当前没有向匿名访问者暴露记录。";
  }
  assert.ok(status === 401 || status === 403, `预期 HTTP 401/403 或空数组，实际 HTTP ${status}。`);
  assert.equal(errorCode(json), "42501", "必须是数据库权限拒绝，不能把无效 key、代理路由拒绝或缺失表当成通过。");
  return `HTTP ${status}，数据库权限拒绝（42501）。`;
}

export async function runPublicChecks({ environment = process.env, fetchImpl = globalThis.fetch } = {}) {
  const { origin, publishableKey, mode } = configuration(environment);
  const result = [];
  async function request(path, body, options = {}) {
    const response = await fetchImpl(new URL(path, origin), {
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        ...(options.public ? {} : { apikey: publishableKey }),
        Accept: "application/json",
        ...(mode === "proxy" ? { Origin: siteOrigin } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
      cache: "no-store",
    });
    const text = await response.text();
    let json;
    try {
      json = response.status === 204 && text === "" ? null : JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${response.status} 返回非 JSON，无法确认权限。`);
    }
    return { status: response.status, json, headers: response.headers };
  }

  function check(label, verify) {
    // Defer the request until execution: the FC deployment permits one instance
    // with five concurrent requests, so a public audit must not load-test it.
    return async () => {
      try {
        const detail = await verify();
        result.push({ label, passed: true, detail });
      } catch (cause) {
        // Do not serialize Response, headers, raw bodies, keys or authentication tokens.
        const message = cause instanceof Error ? cause.message : "检查没有完成。";
        const safeMessage = message.replaceAll(publishableKey, "[公开 key 已隐藏]");
        result.push({ label, passed: false, detail: safeMessage });
      }
    };
  }

  const checks = [
    ...tables.map((table) => check(`匿名 SELECT public.${table}`, async () => {
      const { status, json } = await request(`/rest/v1/${table}?select=${mode === "proxy" ? "*" : "id"}&limit=1`);
      return tableRejection(status, json);
    })),
  ];
  if (mode === "proxy") {
    checks.push(
      check("API 公开健康标识", async () => {
        const { status, json } = await request("/healthz", undefined, { public: true });
        assert.ok(status === 200 && json?.ok === true && json.version === proxyVersion,
          "必须返回 HTTP 200 和本代理的固定版本标识。");
        return `HTTP 200，${proxyVersion}；健康检查不调用上游。`;
      }),
      check("API 合法站点预检", async () => {
        const { status, headers } = await request("/auth/v1/otp", undefined, {
          public: true, method: "OPTIONS", headers: {
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": preflightHeaders.join(","),
          },
        });
        const methods = (headers.get("access-control-allow-methods") || "").split(",").map(part => part.trim());
        const allowedHeaders = (headers.get("access-control-allow-headers") || "").toLowerCase().split(",").map(part => part.trim());
        assert.ok(status === 204 && headers.get("access-control-allow-origin") === siteOrigin
          && methods.includes("POST") && preflightHeaders.every(name => allowedHeaders.includes(name)),
        "合法站点预检必须为204、精确Origin，并允许POST及SDK所需请求头。");
        return "HTTP 204，允许本站POST和SDK请求头；未发送验证码。";
      }),
      check("API 非法站点拒绝", async () => {
        const { status, json } = await request("/healthz", undefined, {
          public: true, headers: { Origin: "https://other.example" },
        });
        assert.ok(status === 403 && json?.error === "origin_not_allowed",
          "非法Origin必须由应用返回403和固定拒绝码。");
        return "HTTP 403，origin_not_allowed；网关补充的CORS响应头不代表应用授权。";
      }),
      check("API 无用户令牌访问 Auth user", async () => {
        const { status } = await request("/auth/v1/user");
        assert.ok(status === 401, "未带用户JWT的Auth user请求必须返回401。");
        return "HTTP 401；未使用用户令牌。";
      }),
      ...["/auth/v1/settings", "/rest/v1/rpc/claim_auth_sms", "/rest/v1/rpc/finish_auth_sms"].map(path =>
        check(`API 禁用路由 ${path}`, async () => {
          const { status, json } = await request(path);
          assert.ok(status === 404 && json?.error === "route_not_allowed",
            "禁用路由必须返回404和代理固定拒绝码，不能视作数据库RLS验证。");
          return "HTTP 404，route_not_allowed；仅检查代理路由边界。";
        }),
      ),
    );
  } else {
    checks.push(
    check("匿名 RPC save_sale", async () => {
      const { status, json } = await request("/rest/v1/rpc/save_sale", {
        p_id: nilUuid,
        p_business_date: "2026-10-15",
        p_extra_income_cents: 0,
        p_note: "anonymous-read-only-security-probe",
        p_items: [],
        p_expected_version: null,
        p_request_id: nilUuid,
      });
      assert.ok(status === 401 || status === 403, `预期无执行权限，实际 HTTP ${status}。`);
      assert.equal(errorCode(json), "42501", "必须是权限拒绝，不能把缺失函数或参数错误当成通过。");
      return `HTTP ${status}，数据库权限拒绝（42501）；没有写入销售。`;
    }),
    check("匿名 RPC void_sale", async () => {
      const { status, json } = await request("/rest/v1/rpc/void_sale", {
        p_id: nilUuid,
        p_expected_version: 1,
      });
      assert.ok(status === 401 || status === 403, `预期无执行权限，实际 HTTP ${status}。`);
      assert.equal(errorCode(json), "42501", "必须是权限拒绝，不能把缺失函数或参数错误当成通过。");
      return `HTTP ${status}，数据库权限拒绝（42501）；没有作废销售。`;
    }),
    ...["claim_auth_sms", "finish_auth_sms"].map((name) =>
      check(`匿名短信 RPC ${name}`, async () => {
        // Invalid identity is rejected before any mutation even if a grant regresses.
        const parameters = { p_digest: "invalid-security-probe", p_claim_id: nilUuid };
        if (name === "finish_auth_sms") parameters.p_sent = false;
        const { status, json } = await request(`/rest/v1/rpc/${name}`, parameters);
        assert.ok(status === 401 || status === 403, `预期无执行权限，实际 HTTP ${status}。`);
        assert.equal(errorCode(json), "42501", "必须是权限拒绝，不能把缺失函数或参数错误当成通过。");
        return `HTTP ${status}，数据库权限拒绝（42501）；没有发送或登记短信。`;
      }),
    ),
    check("公开 Auth settings", async () => {
      const { status, json } = await request("/auth/v1/settings");
      assert.equal(status, 200, "公开 Auth settings 必须可用，确认公开 key 有效。");
      assert.equal(json.external?.email, true, "邮箱认证未开启。");
      assert.equal(json.disable_signup, false, "注册已被关闭。");
      assert.equal(json.mailer_autoconfirm, false, "邮箱自动确认已开启；应保留邮件确认。");
      return "HTTP 200，external.email=true，disable_signup=false，mailer_autoconfirm=false。";
    }),
    );
  }
  // One attempt per check, sequentially; a 429/failure is reported, never retried.
  for (const execute of checks) await execute();
  return { mode, origin, project: expectedProject, result };
}

async function main() {
  const { mode, origin, project, result } = await runPublicChecks();
  console.log(`${mode === "proxy" ? "API 代理" : "Supabase 原站"}公开接口检查：${project}（${origin}）`);
  console.log("身份：未登录；仅 apikey 公开 publishable key；不带用户 JWT。\n");
  for (const entry of result.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"))) {
    console.log(`${entry.passed ? "PASS" : "FAIL"} ${entry.label} — ${entry.detail}`);
  }
  const passed = result.filter((entry) => entry.passed).length;
  console.log(`\n结果：${passed}/${result.length} 项通过。`);
  console.log("未创建账号、未发送邮件，未执行管理员操作；未进行真实账号 JWT 跨商户隔离测试。");
  if (mode === "proxy") console.log("代理模式仅使用GET/OPTIONS，未请求短信、登录或写入RPC；未核验原站Auth settings及私有函数数据库授权。");
  console.log("本检查不能替代已登录后的注册、邮箱确认、密码登录、跨账号 RLS 和写入验证。");
  if (passed !== result.length) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) main().catch(() => {
  // Configuration errors also remain redacted: never print environment values or stacks.
  console.error("FAIL 检查无法启动：请确认 .env.local 中的本项目公开 HTTPS URL 和 publishable key。未输出凭据。");
  process.exitCode = 1;
});
