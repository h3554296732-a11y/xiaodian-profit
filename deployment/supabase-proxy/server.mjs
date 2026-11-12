import http from 'node:http';
import { pathToFileURL } from 'node:url';

// Intentionally not configurable through environment variables, headers or queries.
export const UPSTREAM_ORIGIN = 'https://nporrbvnaezafvryjqao.supabase.co';
export const VERSION = 'lirunben-supabase-proxy-v2';
const SITE_ORIGIN = 'https://lirunben.cn';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const EQ_UUID = new RegExp(`^eq\\.${UUID}$`);
const CURSOR_UUID = new RegExp(`^(eq|gt)\\.${UUID}$`);
const REQUEST_HEADERS = new Set([
  'apikey', 'authorization', 'accept', 'content-type', 'x-client-info',
  'x-supabase-api-version', 'prefer', 'range', 'range-unit',
  'accept-profile', 'content-profile',
]);
const RESPONSE_HEADERS = [
  'content-type', 'content-range', 'range-unit', 'preference-applied',
  'retry-after', 'www-authenticate', 'x-supabase-api-version', 'x-sb-error-code',
  'x-request-id', 'sb-request-id',
];
const TABLES = {
  shops: { methods: ['GET', 'HEAD', 'POST', 'PATCH'], selects: ['*', 'id,name,owner_id'], filters: ['id', 'owner_id'] },
  products: { methods: ['GET', 'HEAD', 'POST', 'PATCH'], selects: ['*'], filters: ['id', 'shop_id', 'updated_at'] },
  sales: { methods: ['GET', 'HEAD'], selects: ['*', '*,sale_items(*)', 'request_id'], filters: ['id', 'shop_id'] },
  sale_items: { methods: ['GET', 'HEAD'], selects: ['*'], filters: ['id', 'shop_id', 'sale_id'] },
  expenses: { methods: ['GET', 'HEAD', 'POST', 'PATCH'], selects: ['*'], filters: ['id', 'shop_id', 'deleted_at'] },
  inventory_levels: { methods: ['GET', 'HEAD'], selects: ['*'], filters: ['id', 'shop_id'] },
  inventory_receipts: { methods: ['GET', 'HEAD'], selects: ['*'], filters: ['id', 'shop_id'] },
};
const AUTH = {
  otp: ['POST'], verify: ['POST'], token: ['POST'], user: ['GET', 'HEAD', 'PUT'],
  signup: ['POST'], recover: ['POST'], resend: ['POST'], logout: ['POST'],
};

class RequestError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const reject = (status, code) => { throw new RequestError(status, code); };

function parseHost(value) {
  if (typeof value !== 'string' || !value || value.length > 253 || !/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/.test(value))
    throw new Error('Configure exact DNS host names, optionally with ports.');
  const [name, port] = value.split(':');
  if (!name.split('.').every(part => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(part)) || (port && (Number(port) < 1 || Number(port) > 65535)))
    throw new Error('Invalid public host.');
  return value.toLowerCase();
}

function originAllowlist(localOrigins) {
  const origins = new Set([SITE_ORIGIN]);
  for (const origin of localOrigins) {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || !url.port)
      throw new Error('Local origins must be explicit http://localhost:port or http://127.0.0.1:port origins.');
    origins.add(origin);
  }
  return origins;
}

function queryParams(rawQuery) {
  if (!rawQuery) return new URLSearchParams();
  if (/%(?![0-9a-fA-F]{2})/.test(rawQuery) || rawQuery.split('&').some(part => !part.includes('='))) reject(400, 'invalid_query');
  const params = new URLSearchParams(rawQuery);
  const seen = new Set();
  if ([...params].length > 12) reject(400, 'invalid_query');
  for (const [name, value] of params) {
    if (seen.has(name) || !name || !value || /[\u0000-\u001f\u007f\ufffd%]/u.test(name + value)) reject(400, 'invalid_query');
    seen.add(name);
  }
  return params;
}

function validateRoute(rawTarget, method, allowedOrigins) {
  // Validate BEFORE URL construction: URL normalizes dot segments and backslashes.
  if (!rawTarget || rawTarget.length > 8192 || !rawTarget.startsWith('/') || /[\s\\#\u0000-\u001f\u007f]/u.test(rawTarget)) reject(400, 'invalid_target');
  const question = rawTarget.indexOf('?');
  const path = question < 0 ? rawTarget : rawTarget.slice(0, question);
  if (!/^\/[a-z0-9/_]+$/.test(path) || path.includes('//') || path.endsWith('/')) reject(400, 'invalid_path');
  const query = queryParams(question < 0 ? '' : rawTarget.slice(question + 1));
  let methods;
  if (path === '/healthz') {
    methods = ['GET', 'HEAD'];
    if (query.size) reject(400, 'invalid_query');
  } else if (path.startsWith('/auth/v1/')) {
    const endpoint = path.slice('/auth/v1/'.length);
    methods = Object.hasOwn(AUTH, endpoint) ? AUTH[endpoint] : undefined;
    if (!methods) reject(404, 'route_not_allowed');
    const allowed = endpoint === 'token' ? ['grant_type'] : endpoint === 'logout' ? ['scope'] : ['signup', 'recover', 'resend', 'otp', 'user', 'verify'].includes(endpoint) ? ['redirect_to'] : [];
    for (const [key, value] of query) {
      if (!allowed.includes(key)) reject(400, 'invalid_query');
      if (key === 'grant_type' && !['password', 'refresh_token'].includes(value)) reject(400, 'invalid_query');
      if (key === 'scope' && value !== 'local') reject(400, 'invalid_query');
      if (key === 'redirect_to') {
        let redirect;
        try { redirect = new URL(value); } catch { reject(400, 'invalid_redirect'); }
        if (!allowedOrigins.has(redirect.origin) || redirect.username || redirect.password || !['/account', '/account/'].includes(redirect.pathname) || redirect.search || redirect.hash)
          reject(400, 'invalid_redirect');
      }
    }
    if (endpoint === 'token' && !query.has('grant_type')) reject(400, 'invalid_query');
  } else if (['/rest/v1/rpc/save_sale', '/rest/v1/rpc/void_sale', '/rest/v1/rpc/count_inventory', '/rest/v1/rpc/receive_inventory'].includes(path)) {
    methods = ['POST'];
    if (query.size) reject(400, 'invalid_query');
  } else {
    const tableName = path.startsWith('/rest/v1/') ? path.slice('/rest/v1/'.length) : '';
    const table = Object.hasOwn(TABLES, tableName) ? TABLES[tableName] : undefined;
    if (!table) reject(404, 'route_not_allowed');
    methods = table.methods;
    for (const [key, value] of query) {
      let valid = false;
      if (key === 'select') valid = table.selects.includes(value);
      else if (key === 'order') valid = ['GET', 'HEAD'].includes(method) && value === 'id.asc';
      else if (key === 'limit') valid = ['GET', 'HEAD'].includes(method) && /^[1-9][0-9]{0,2}$/.test(value) && Number(value) <= 500;
      else if (table.filters.includes(key) && method !== 'POST') {
        if (key === 'deleted_at') valid = value === 'is.null';
        else if (key === 'updated_at') valid = /^eq\.\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value);
        else valid = (key === 'id' && ['GET', 'HEAD'].includes(method) ? CURSOR_UUID : EQ_UUID).test(value);
      }
      if (!valid) reject(400, 'invalid_query');
    }
  }
  if (!methods.includes(method)) reject(405, 'method_not_allowed');
  return { path, methods, query };
}

function singletonHeader(request, name) {
  const values = request.headersDistinct[name];
  if (values && values.length !== 1) reject(400, 'duplicate_header');
  return values?.[0];
}

function forwardHeaders(request) {
  const headers = new Headers();
  const apiKey = singletonHeader(request, 'apikey');
  if (!apiKey || !/^sb_publishable_[a-zA-Z0-9_-]{1,200}$/.test(apiKey)) reject(401, 'publishable_key_required');
  for (const name of REQUEST_HEADERS) {
    const value = singletonHeader(request, name);
    if (value === undefined) continue;
    if (value.length > (name === 'authorization' ? 8192 : 1024)) reject(400, 'invalid_header');
    if (name === 'authorization') {
      if (!/^Bearer [a-zA-Z0-9._~-]+$/.test(value) || value.includes('sb_secret_')) reject(400, 'invalid_authorization');
      // This only rejects privileged credentials; Supabase still verifies user JWTs.
      const token = value.slice(7);
      if (token.split('.').length === 3) {
        try {
          const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
          if (payload.role === 'service_role' || payload.role === 'supabase_admin') reject(400, 'privileged_credential_not_allowed');
        } catch (error) { if (error instanceof RequestError) throw error; }
      }
    }
    if (['accept-profile', 'content-profile'].includes(name) && value !== 'public') reject(400, 'invalid_profile');
    if (name === 'range' && (!/^\d{1,9}-\d{1,9}$/.test(value) || Number(value.split('-')[1]) < Number(value.split('-')[0]) || Number(value.split('-')[1]) - Number(value.split('-')[0]) >= 500)) reject(400, 'invalid_range');
    if (name === 'range-unit' && value !== 'items') reject(400, 'invalid_range');
    if (name === 'prefer' && !value.split(',').every(part => /^(return=(representation|minimal)|count=(exact|planned|estimated))$/.test(part.trim()))) reject(400, 'invalid_prefer');
    headers.set(name, value);
  }
  // No cookies, forwarding headers, conditional requests, client Host or Origin.
  headers.set('cache-control', 'no-store');
  headers.set('pragma', 'no-cache');
  headers.set('accept-encoding', 'identity');
  return headers;
}

function readRequestBody(request, limit) {
  const length = singletonHeader(request, 'content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) reject(413, 'request_too_large');
  return new Promise((resolve, rejectPromise) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      request.off('data', onData); request.off('end', onEnd);
      request.off('error', onError); request.off('aborted', onAborted);
    };
    const onError = () => { cleanup(); rejectPromise(new RequestError(400, 'invalid_body')); };
    const onAborted = onError;
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) {
        cleanup(); request.pause(); rejectPromise(new RequestError(413, 'request_too_large')); return;
      }
      chunks.push(chunk);
    };
    request.on('data', onData); request.on('end', onEnd);
    request.on('error', onError); request.on('aborted', onAborted);
  });
}

async function readResponseBody(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) reject(502, 'upstream_response_too_large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

function privateHeaders(response) {
  response.setHeader('cache-control', 'private, no-store, max-age=0');
  response.setHeader('pragma', 'no-cache');
  response.setHeader('expires', '0');
  response.setHeader('vary', 'Origin');
  response.setHeader('x-content-type-options', 'nosniff');
}

export function createProxyServer({ publicHosts, localOrigins = [], fetchImpl = globalThis.fetch, maxBodyBytes = MAX_BODY_BYTES, maxResponseBytes = MAX_RESPONSE_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  if (!Array.isArray(publicHosts) || !publicHosts.length) throw new Error('PROXY_PUBLIC_HOSTS must list the exact incoming FC/custom-domain hosts.');
  const hosts = new Set(publicHosts.map(parseHost));
  const origins = originAllowlist(localOrigins);
  const server = http.createServer({ maxHeaderSize: 16 * 1024, requireHostHeader: true }, async (request, response) => {
    privateHeaders(response);
    let timeout;
    let controller;
    const abort = () => controller?.abort();
    const abortOnClose = () => { if (!response.writableFinished) abort(); };
    try {
      const host = singletonHeader(request, 'host');
      let canonicalHost;
      try { canonicalHost = parseHost(host); } catch { reject(400, 'invalid_host'); }
      if (!hosts.has(canonicalHost)) reject(400, 'invalid_host');
      const origin = singletonHeader(request, 'origin');
      if (origin !== undefined && !origins.has(origin)) reject(403, 'origin_not_allowed');
      if (origin) {
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('access-control-expose-headers', RESPONSE_HEADERS.join(', '));
      }
      const method = request.method;
      if (method === 'OPTIONS') {
        if (!origin) reject(400, 'preflight_origin_required');
        const requestedMethod = singletonHeader(request, 'access-control-request-method');
        if (!requestedMethod || !/^[A-Z]+$/.test(requestedMethod)) reject(400, 'invalid_preflight');
        const route = validateRoute(request.url, requestedMethod, origins);
        const requestedHeaders = singletonHeader(request, 'access-control-request-headers') || '';
        if (requestedHeaders && !requestedHeaders.split(',').every(name => REQUEST_HEADERS.has(name.trim().toLowerCase()))) reject(400, 'header_not_allowed');
        response.setHeader('access-control-allow-methods', route.methods.join(', '));
        if (requestedHeaders) response.setHeader('access-control-allow-headers', requestedHeaders.toLowerCase());
        response.statusCode = 204;
        response.end();
        return;
      }
      const { path } = validateRoute(request.url, method, origins);
      if (path === '/healthz') {
        if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0)) reject(400, 'body_not_allowed');
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.statusCode = 200;
        response.end(method === 'HEAD' ? undefined : JSON.stringify({ ok: true, version: VERSION }));
        return;
      }
      const headers = forwardHeaders(request);
      if (['GET', 'HEAD'].includes(method) && (request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0))) reject(400, 'body_not_allowed');
      if (request.headers['content-encoding']) reject(415, 'content_encoding_not_allowed');
      if (!['GET', 'HEAD'].includes(method) && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers.get('content-type') || '')) reject(415, 'json_required');
      const body = await readRequestBody(request, maxBodyBytes);
      if (body.length) {
        let json;
        try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { reject(400, 'invalid_json'); }
        if (!json || typeof json !== 'object' || Array.isArray(json)) reject(400, 'json_object_required');
      } else if (!['GET', 'HEAD'].includes(method) && path !== '/auth/v1/logout') reject(400, 'json_object_required');
      controller = new AbortController();
      timeout = setTimeout(abort, timeoutMs);
      request.once('aborted', abort);
      response.once('close', abortOnClose);
      // Exactly one fetch per accepted request, including writes and failures.
      const upstream = await fetchImpl(`${UPSTREAM_ORIGIN}${request.url}`, {
        method, headers, body: body.length ? body : undefined,
        redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
      const noBody = method === 'HEAD' || [204, 205, 304].includes(upstream.status);
      const data = noBody ? Buffer.alloc(0) : await readResponseBody(upstream, maxResponseBytes);
      if (noBody && upstream.body) await upstream.body.cancel();
      response.statusCode = upstream.status;
      for (const name of RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) response.setHeader(name, value);
      }
      if (!noBody) response.setHeader('content-length', data.length);
      response.end(noBody ? undefined : data);
    } catch (error) {
      if (!response.destroyed && !response.headersSent) {
        response.statusCode = error instanceof RequestError ? error.status : controller?.signal.aborted ? 504 : 502;
        response.setHeader('connection', 'close');
        response.setHeader('content-type', 'application/json; charset=utf-8');
        const code = error instanceof RequestError ? error.code : response.statusCode === 504 ? 'upstream_timeout' : 'upstream_unavailable';
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ error: code }));
      } else if (!response.destroyed) response.destroy();
      // Deliberately no URL, header, body, token, upstream exception or access logs.
    } finally {
      clearTimeout(timeout);
      request.off('aborted', abort);
      response.off('close', abortOnClose);
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const csv = value => (value || '').split(',').map(part => part.trim()).filter(Boolean);
  const server = createProxyServer({ publicHosts: csv(process.env.PROXY_PUBLIC_HOSTS), localOrigins: csv(process.env.PROXY_LOCAL_ORIGINS) });
  server.listen(9000, '0.0.0.0', () => console.info(`${VERSION} listening on 0.0.0.0:9000`));
}
