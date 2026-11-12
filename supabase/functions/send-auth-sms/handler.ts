export type SignedRequest = {
  method: string;
  pathname: string;
  query: Record<string, string>;
  headers: Record<string, string>;
};

export type Authorize = (
  request: SignedRequest,
  algorithm: string,
  payloadHash: string,
  accessKeyId: string,
  accessKeySecret: string,
) => string;

export type VerifySignature = (
  secret: string,
  payload: string,
  headers: Record<string, string>,
) => void;

type ReadEnv = (name: string) => string | undefined;
// Exact values from PNVS's API return-code list and Alibaba OpenAPI errors.
// Never log a merely well-formed arbitrary Code: it can still contain PII.
const safeProviderCodes = [
  "OK",
  "InvalidAccessKeyId.NotFound",
  "SignatureDoesNotMatch",
  "Forbidden.RAM",
  "Forbidden.NoPermission",
  "InvalidSecurityToken.Expired",
  "InvalidSecurityToken.NotFound",
  "InvalidTimeStamp.Expired",
  "MOBILE_NUMBER_ILLEGAL",
  "BUSINESS_LIMIT_CONTROL",
  "FREQUENCY_FAIL",
  "INVALID_PARAMETERS",
  "FUNCTION_NOT_OPENED",
  "isv.RAM_PERMISSION_DENY",
  "isv.PRODUCT_UNSUBSCRIBE",
  "isv.PRODUCT_UN_SUBSCRIPT",
  "isv.OUT_OF_SERVICE",
  "isv.MOBILE_NUMBER_ILLEGAL",
  "isv.INVALID_PARAMETERS",
  "isv.BUSINESS_LIMIT_CONTROL",
  "isv.SMS_TEMPLATE_ILLEGAL",
  "biz.FREQUENCY",
  "InvalidParameter.SmsTemplateCode",
  "EntityNotExist.SmsTemplateCode",
  "EntityNotExist.SmsSignName",
  "LimitExceeded.SmsCode",
] as const;

export type SmsDiagnostic = {
  stage: "claim" | "provider" | "finish_sent" | "finish_unknown";
  reason:
    | "http_error"
    | "rejected"
    | "transport_error"
    | "invalid_response"
    | "invalid_request"
    | "signing_error"
    | "timeout"
    | "budget_exhausted"
    | "not_confirmed";
  http_status?: number;
  provider_code?: (typeof safeProviderCodes)[number] | "OTHER";
  transport_kind?: "dns" | "tls" | "connect" | "redirect" | "unknown";
};

type SmsConfig = {
  hookSecrets: string[];
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
  signName: string;
  templateCode: string;
  ttlSeconds: number;
  supabaseUrl: string;
  serviceKey: string;
};

type Dependencies = {
  readEnv: ReadEnv;
  verifySignature: VerifySignature;
  authorize: Authorize;
  fetch: typeof fetch;
  providerTimeoutMs?: number;
  claimTimeoutMs?: number;
  rpcTimeoutMs?: number;
  hookTimeoutMs?: number;
  onDiagnostic?: (event: SmsDiagnostic) => void;
};

const endpoint = "https://dypnsapi.aliyuncs.com/";
const maxBodyBytes = 32 * 1024;
const algorithm = "ACS3-HMAC-SHA256";

function diagnose(dependencies: Dependencies, event: SmsDiagnostic): void {
  try {
    dependencies.onDiagnostic?.({
      stage: event.stage,
      reason: event.reason,
      ...(Number.isInteger(event.http_status) &&
      event.http_status! >= 100 &&
      event.http_status! <= 599
        ? { http_status: event.http_status }
        : {}),
      ...(event.provider_code === undefined
        ? {}
        : { provider_code: providerCode(event.provider_code) }),
      ...(event.transport_kind === undefined
        ? {}
        : { transport_kind: event.transport_kind }),
    });
  } catch {
    // Observability must not affect delivery, error handling, or deduplication.
  }
}

function providerCode(value: unknown): SmsDiagnostic["provider_code"] {
  return typeof value === "string" &&
    (safeProviderCodes as readonly string[]).includes(value)
    ? (value as (typeof safeProviderCodes)[number])
    : "OTHER";
}

function transportKind(
  error: unknown,
): NonNullable<SmsDiagnostic["transport_kind"]> {
  // Inspect at most three native Error/cause messages in memory. Return only a
  // fixed category; never pass through message, name, stack, code, or cause.
  try {
    let current = error;
    for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
      const message =
        typeof current.message === "string" ? current.message : "";
      if (
        /encountered redirect|redirect mode is set to|unexpected redirect/i.test(
          message,
        )
      )
        return "redirect";
      if (
        /dns error|dns lookup|failed to lookup address|name or service not known|temporary failure in name resolution|\bENOTFOUND\b|\bEAI_AGAIN\b/i.test(
          message,
        )
      )
        return "dns";
      if (/certificate|\btls\b|\bssl\b/i.test(message)) return "tls";
      if (
        /tcp connect|connection (?:refused|reset|closed|error)|\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b/i.test(
          message,
        )
      )
        return "connect";
      current = current.cause;
    }
  } catch {
    // An unexpected Error implementation must not break or leak diagnostics.
  }
  return "unknown";
}

class HookError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function required(readEnv: ReadEnv, name: string): string {
  const value = readEnv(name);
  if (!value || !value.trim())
    throw new HookError(503, "短信服务尚未配置完成。");
  return value.trim();
}

function config(readEnv: ReadEnv): SmsConfig {
  const hookSecrets = required(readEnv, "SEND_SMS_HOOK_SECRET")
    .split("|")
    .map((secret) => secret.replace(/^v1,/, ""));
  if (
    hookSecrets.length > 4 ||
    hookSecrets.some((secret) => {
      if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return true;
      try {
        const length = atob(secret.slice(6)).length;
        return length < 32 || length > 64;
      } catch {
        return true;
      }
    })
  )
    throw new HookError(503, "短信服务尚未配置完成。");
  const ttl = (readEnv("SMS_OTP_TTL_SECONDS") ?? "300").trim();
  const ttlSeconds = Number(ttl);
  if (
    !/^\d+$/.test(ttl) ||
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 60 ||
    ttlSeconds > 3600 ||
    ttlSeconds % 60 !== 0
  )
    throw new HookError(503, "短信服务尚未配置完成。");
  return {
    hookSecrets,
    accessKeyId: required(readEnv, "ALIYUN_ACCESS_KEY_ID"),
    accessKeySecret: required(readEnv, "ALIYUN_ACCESS_KEY_SECRET"),
    securityToken: readEnv("ALIYUN_SECURITY_TOKEN")?.trim() || undefined,
    signName: required(readEnv, "ALIYUN_SMS_SIGN_NAME"),
    templateCode: required(readEnv, "ALIYUN_SMS_TEMPLATE_CODE"),
    ttlSeconds,
    supabaseUrl: required(readEnv, "SUPABASE_URL").replace(/\/$/, ""),
    serviceKey: required(readEnv, "SUPABASE_SERVICE_ROLE_KEY"),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function smsTarget(payload: unknown): { phone: string; otp: string } {
  const event = object(payload);
  const sms = object(event?.sms);
  const user = object(event?.user);
  // Auth normalizes +861... to 861.... Newer hooks carry the actual destination
  // in sms.phone; use it for phone changes rather than the user's old number.
  const phone = sms && "phone" in sms ? sms.phone : user?.phone;
  const otp = sms?.otp;
  if (
    typeof phone !== "string" ||
    !/^\+?861[3-9]\d{9}$/.test(phone) ||
    typeof otp !== "string" ||
    !/^\d{6}$/.test(otp)
  )
    throw new HookError(400, "仅支持中国大陆手机号和六位短信验证码。");
  return { phone: phone.replace(/^\+?86/, ""), otp };
}

async function readBody(
  request: Request,
  signal: AbortSignal,
): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new HookError(400, "短信请求内容无效。");
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBodyBytes) {
        await reader.cancel();
        throw new HookError(413, "短信请求内容过大。");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HookError(400, "短信请求内容无效。");
  }
}

function remaining(deadline: number, cap: number, reserve = 0): number {
  const available = Math.floor(deadline - performance.now() - reserve);
  if (available <= 0)
    throw new HookError(422, "短信发送状态暂时无法确认，请稍后重新申请。");
  return Math.min(cap, available);
}

async function bounded<T>(
  action: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  failure: HookError,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(failure);
        controller.abort();
      }, milliseconds);
    });
    return await Promise.race([action(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function fingerprint(raw: string, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const hmac = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    hmac,
    encoder.encode(`send-auth-sms:v1\0${raw}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function rpc(
  name: "claim_auth_sms" | "finish_auth_sms",
  parameters: Record<string, string | boolean>,
  settings: SmsConfig,
  dependencies: Dependencies,
  deadline: number,
): Promise<unknown> {
  const failure = new HookError(
    422,
    "短信发送状态暂时无法确认，请稍后重新申请。",
  );
  const timeoutFailure = new HookError(failure.status, failure.message);
  const stage =
    name === "claim_auth_sms"
      ? "claim"
      : parameters.p_sent === true
        ? "finish_sent"
        : "finish_unknown";
  let reason: SmsDiagnostic["reason"] = "transport_error";
  let httpStatus: number | undefined;
  try {
    return await bounded(
      async (signal) => {
        const response = await dependencies.fetch(
          `${settings.supabaseUrl}/rest/v1/rpc/${name}`,
          {
            method: "POST",
            headers: {
              apikey: settings.serviceKey,
              authorization: `Bearer ${settings.serviceKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(parameters),
            signal,
            redirect: "error",
          },
        );
        httpStatus = response.status;
        if (!response.ok) {
          reason = "http_error";
          throw failure;
        }
        reason = "invalid_response";
        return await response.json();
      },
      remaining(
        deadline,
        name === "claim_auth_sms"
          ? (dependencies.claimTimeoutMs ?? dependencies.rpcTimeoutMs ?? 2000)
          : (dependencies.rpcTimeoutMs ?? 600),
      ),
      timeoutFailure,
    );
  } catch (error) {
    diagnose(dependencies, {
      stage,
      reason:
        error === timeoutFailure
          ? "timeout"
          : error instanceof HookError && error !== failure
            ? "budget_exhausted"
            : reason,
      ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
      ...(reason === "transport_error" && !(error instanceof HookError)
        ? { transport_kind: transportKind(error) }
        : {}),
    });
    // A failed/aborted RPC may still have committed. Never proceed on ambiguity.
    throw failure;
  }
}

async function sendSms(
  settings: SmsConfig,
  target: { phone: string; otp: string },
  dependencies: Dependencies,
  deadline: number,
): Promise<void> {
  // Match the official Dypnsapi SDK: these RPC parameters are query parameters.
  const query = {
    CountryCode: "86",
    PhoneNumber: target.phone,
    SignName: settings.signName,
    TemplateCode: settings.templateCode,
    // Supabase owns generation and verification. Never use ##code## here.
    TemplateParam: JSON.stringify({
      code: target.otp,
      min: String(settings.ttlSeconds / 60),
    }),
    CodeLength: "6",
    ValidTime: String(settings.ttlSeconds),
    ReturnVerifyCode: "false",
    AutoRetry: "0",
  };
  const body = "";
  const payloadHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const headers: Record<string, string> = {
    host: new URL(endpoint).host,
    "x-acs-action": "SendSmsVerifyCode",
    "x-acs-version": "2017-05-25",
    "x-acs-date": new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    "x-acs-signature-nonce": crypto.randomUUID(),
    "x-acs-content-sha256": payloadHash,
  };
  if (settings.securityToken)
    headers["x-acs-security-token"] = settings.securityToken;
  try {
    headers.authorization = dependencies.authorize(
      { method: "POST", pathname: "/", query, headers },
      algorithm,
      payloadHash,
      settings.accessKeyId,
      settings.accessKeySecret,
    );
  } catch (error) {
    diagnose(dependencies, { stage: "provider", reason: "signing_error" });
    throw error;
  }
  let httpStatus: number | undefined;
  let code: SmsDiagnostic["provider_code"] = "OTHER";
  let reason: SmsDiagnostic["reason"] = "transport_error";
  const timeoutFailure = new HookError(504, "短信服务响应超时，请稍后再试。");
  try {
    await bounded(
      async (signal) => {
        const url = `${endpoint}?${new URLSearchParams(query)}`;
        const init = {
          method: "POST",
          headers,
          signal,
          redirect: "error",
        } as const;
        try {
          // Validate headers/URL without sending. Preserve fetch's input/init
          // interface so this introduces no additional provider invocation.
          new Request(url, init);
        } catch {
          reason = "invalid_request";
          throw new HookError(502, "短信发送失败，请稍后再试。");
        }
        const response = await dependencies.fetch(url, init);
        httpStatus = response.status;
        reason = response.ok ? "invalid_response" : "http_error";
        let result: Record<string, unknown> | null;
        try {
          result = object(await response.json());
        } catch (error) {
          if (response.ok) throw error;
          result = null;
        }
        code = providerCode(result?.Code);
        if (!response.ok || result?.Code !== "OK" || result.Success !== true) {
          reason = response.ok ? "rejected" : "http_error";
          throw new HookError(502, "短信发送失败，请稍后再试。");
        }
      },
      remaining(
        deadline,
        dependencies.providerTimeoutMs ?? 4500,
        dependencies.rpcTimeoutMs ?? 600,
      ),
      timeoutFailure,
    );
  } catch (error) {
    diagnose(dependencies, {
      stage: "provider",
      reason:
        error === timeoutFailure
          ? "timeout"
          : error instanceof HookError && error.status === 422
            ? "budget_exhausted"
            : reason,
      ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
      provider_code: code,
      ...(reason === "transport_error" && !(error instanceof HookError)
        ? { transport_kind: transportKind(error) }
        : {}),
    });
    // A known non-2xx response remains an HTTP failure even if its optional
    // diagnostic body stalls. No retry or durable-state semantics change.
    if (httpStatus !== undefined && (httpStatus < 200 || httpStatus >= 300))
      throw new HookError(502, "短信发送失败，请稍后再试。");
    if (error instanceof HookError) throw error;
    // Provider bodies and exception messages may contain PII or credentials.
    throw new HookError(502, "短信发送失败，请稍后再试。");
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function createSmsHandler(dependencies: Dependencies) {
  return async function handle(request: Request): Promise<Response> {
    const deadline = performance.now() + (dependencies.hookTimeoutMs ?? 4500);
    try {
      if (request.method !== "POST")
        throw new HookError(405, "仅支持 POST 请求。");
      const headers = Object.fromEntries(request.headers);
      const timestamp = headers["webhook-timestamp"];
      if (
        !headers["webhook-id"] ||
        !headers["webhook-signature"] ||
        !timestamp ||
        !/^\d{1,12}$/.test(timestamp) ||
        String(Number(timestamp)) !== timestamp
      )
        throw new HookError(401, "短信请求签名无效。");
      if (
        request.headers.get("content-type")?.split(";")[0].trim() !==
        "application/json"
      )
        throw new HookError(415, "短信请求格式无效。");
      const settings = config(dependencies.readEnv);
      const raw = await bounded(
        (signal) => readBody(request, signal),
        remaining(deadline, 400),
        new HookError(422, "短信请求读取超时，请稍后再试。"),
      );
      const verified = settings.hookSecrets.some((secret) => {
        try {
          dependencies.verifySignature(secret, raw, headers);
          return true;
        } catch {
          return false;
        }
      });
      if (!verified) throw new HookError(401, "短信请求签名无效。");
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new HookError(400, "短信请求内容无效。");
      }
      const target = smsTarget(payload);
      const digest = await fingerprint(raw, settings.serviceKey);
      const claimId = crypto.randomUUID();
      const parameters = { p_digest: digest, p_claim_id: claimId };
      const claim = await rpc(
        "claim_auth_sms",
        parameters,
        settings,
        dependencies,
        deadline,
      );
      if (claim === "sent") return json({}, 200);
      if (claim !== "claimed") {
        diagnose(dependencies, { stage: "claim", reason: "not_confirmed" });
        throw new HookError(
          422,
          "短信请求正在处理或结果未确认，请稍后重新申请。",
        );
      }
      try {
        await sendSms(settings, target, dependencies, deadline);
      } catch (error) {
        try {
          await rpc(
            "finish_auth_sms",
            { ...parameters, p_sent: false },
            settings,
            dependencies,
            deadline,
          );
        } catch {
          /* Keep the durable pending claim if marking unknown is uncertain. */
        }
        throw error;
      }
      const completed = await rpc(
        "finish_auth_sms",
        { ...parameters, p_sent: true },
        settings,
        dependencies,
        deadline,
      );
      if (completed !== true) {
        diagnose(dependencies, {
          stage: "finish_sent",
          reason: "not_confirmed",
        });
        throw new HookError(422, "短信发送状态暂时无法确认，请稍后重新申请。");
      }
      return json({}, 200);
    } catch (error) {
      const failure =
        error instanceof HookError
          ? error
          : new HookError(500, "短信请求处理失败，请稍后再试。");
      return json(
        { error: { http_code: failure.status, message: failure.message } },
        failure.status,
      );
    }
  };
}
