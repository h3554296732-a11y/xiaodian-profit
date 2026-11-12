import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer, UPSTREAM_ORIGIN, VERSION } from './server.mjs';

const KEY = 'sb_publishable_local_test_only';
const TOKEN = 'eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.mock';
const UUID = '12345678-1234-1234-1234-123456789abc';
const SITE = 'https://lirunben.cn';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, { handler, fetchImpl, ...options } = {}) {
  const received = [];
  const calls = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const entry = { method: request.method, path: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() };
    received.push(entry);
    if (handler) return handler(request, response, entry);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ mock: true }));
  });
  const localUpstream = await listen(upstream);
  const proxy = createProxyServer({
    publicHosts: ['proxy.test'], ...options,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, UPSTREAM_ORIGIN, 'production origin is fixed even under attack');
      calls.push({ url, init });
      // All accepted requests terminate at this local mock, never at Supabase.
      return fetchImpl ? fetchImpl(url, init) : fetch(`${localUpstream}${parsed.pathname}${parsed.search}`, init);
    },
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => {
    await Promise.all([proxy, upstream].map(server => new Promise(resolve => {
      server.closeAllConnections();
      server.close(resolve);
    })));
  });
  const request = (path, { method = 'GET', headers = {}, body, chunks } = {}) => new Promise((resolve, reject) => {
    const req = http.request(proxyUrl, {
      method, path,
      headers: Object.fromEntries(Object.entries({
        host: 'proxy.test', origin: SITE, apikey: KEY,
        ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'content-type': 'application/json' } : {}),
        ...headers,
      }).filter(([, value]) => value !== undefined)),
    }, res => {
      const buffers = [];
      res.on('data', chunk => buffers.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(buffers).toString() }));
    });
    req.on('error', reject);
    if (chunks) for (const chunk of chunks) req.write(chunk);
    req.end(body);
  });
  return { request, calls, received };
}

test('health is public, versioned, uncached and never calls the upstream', async t => {
  const f = await fixture(t);
  const response = await f.request('/healthz', { headers: { apikey: undefined, origin: undefined } });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, version: VERSION });
  assert.match(response.headers['cache-control'], /no-store/);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  const head = await f.request('/healthz', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(f.calls.length, 0);
});

test('CORS permits exactly the site origin and exposes necessary API headers', async t => {
  const f = await fixture(t);
  const ok = await f.request('/rest/v1/shops');
  assert.equal(ok.headers['access-control-allow-origin'], SITE);
  assert.equal(ok.headers.vary, 'Origin');
  assert.match(ok.headers['access-control-expose-headers'], /content-range/);
  assert.equal(ok.headers['access-control-allow-credentials'], undefined);
  for (const origin of ['null', 'https://www.lirunben.cn', 'https://lirunben.cn.evil.test', 'http://localhost:3000']) {
    const denied = await f.request('/auth/v1/otp', { method: 'POST', body: '{}', headers: { origin } });
    assert.equal(denied.status, 403, origin);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(f.calls.length, 1);
});

test('localhost is allowed only as an explicit exact local configuration', async t => {
  const f = await fixture(t, { localOrigins: ['http://localhost:3000'] });
  const allowed = await f.request('/healthz', { headers: { origin: 'http://localhost:3000' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:3000');
  assert.equal((await f.request('/healthz', { headers: { origin: 'http://localhost:3001' } })).status, 403);
  for (const origin of ['https://evil.test', 'http://localhost', 'http://localhost:3000/path', 'http://user@localhost:3000']) {
    assert.throws(() => createProxyServer({ publicHosts: ['proxy.test'], localOrigins: [origin] }));
  }
});

test('preflight validates the requested route, method and headers without forwarding', async t => {
  const f = await fixture(t);
  const response = await f.request('/auth/v1/otp', {
    method: 'OPTIONS', headers: {
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'apikey, authorization, content-type, x-client-info, x-supabase-api-version',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.body, '');
  assert.equal(response.headers['access-control-allow-methods'], 'POST');
  assert.match(response.headers['cache-control'], /no-store/);
  for (const [path, headers, status] of [
    ['/auth/v1/otp', { 'access-control-request-method': 'DELETE' }, 405],
    ['/auth/v1/admin/users', { 'access-control-request-method': 'GET' }, 404],
    ['/auth/v1/otp', { 'access-control-request-method': 'POST', 'access-control-request-headers': 'cookie' }, 400],
    ['/auth/v1/otp', { 'access-control-request-method': 'POST', origin: undefined }, 400],
  ]) assert.equal((await f.request(path, { method: 'OPTIONS', headers })).status, status);
  assert.equal(f.calls.length, 0);
});

test('forwards publishable key, exact user bearer and body while stripping transport/privileged headers', async t => {
  const f = await fixture(t);
  const body = JSON.stringify({ phone: '+8613800000000', create_user: true, channel: 'sms' });
  const response = await f.request('/auth/v1/otp', {
    method: 'POST', body,
    headers: { authorization: `Bearer ${TOKEN}`, cookie: 'private=value', 'x-forwarded-host': 'evil.test', 'x-forwarded-for': '1.2.3.4', 'x-client-info': 'local-test', 'x-supabase-api-version': '2024-01-01' },
  });
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${UPSTREAM_ORIGIN}/auth/v1/otp`);
  assert.equal(f.calls[0].init.redirect, 'error');
  assert.equal(f.calls[0].init.cache, 'no-store');
  const sent = f.received[0];
  assert.equal(sent.headers.apikey, KEY);
  assert.equal(sent.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(sent.headers['x-client-info'], 'local-test');
  assert.equal(sent.headers['x-supabase-api-version'], '2024-01-01');
  assert.equal(sent.headers.cookie, undefined);
  assert.equal(sent.headers.origin, undefined);
  assert.equal(sent.headers['x-forwarded-for'], undefined);
  assert.equal(sent.headers['x-forwarded-host'], undefined);
  assert.notEqual(sent.headers.host, 'proxy.test');
  assert.equal(sent.body, body);
  assert.equal(sent.headers['cache-control'], 'no-store');
});

test('email, phone, refresh, recovery and local logout request shapes reach only the mock', async t => {
  const f = await fixture(t);
  for (const [method, path, body] of [
    ['POST', '/auth/v1/verify', { phone: '+8613800000000', token: '000000', type: 'sms' }],
    ['POST', '/auth/v1/token?grant_type=password', { email: 'mock@example.test', password: 'mock-only' }],
    ['POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: 'mock-only' }],
    ['POST', `/auth/v1/signup?redirect_to=${encodeURIComponent(`${SITE}/account/`)}`, { email: 'mock@example.test', password: 'mock-only' }],
    ['POST', `/auth/v1/recover?redirect_to=${encodeURIComponent(`${SITE}/account/`)}`, { email: 'mock@example.test' }],
    ['POST', '/auth/v1/resend', { email: 'mock@example.test', type: 'signup' }],
    ['GET', '/auth/v1/user'],
    ['PUT', '/auth/v1/user', { password: 'mock-only' }],
    ['POST', '/auth/v1/logout?scope=local'],
  ]) {
    const result = await f.request(path, { method, body: body ? JSON.stringify(body) : undefined });
    assert.equal(result.status, 200, `${method} ${path}`);
  }
  assert.equal(f.calls.length, 9);
});

test('supports only actual table methods, nested sales selection, cursor filters and two sale RPCs', async t => {
  const f = await fixture(t);
  const accepted = [
    ['GET', `/rest/v1/shops?select=id%2Cname%2Cowner_id&owner_id=eq.${UUID}`],
    ['GET', `/rest/v1/products?select=*&shop_id=eq.${UUID}&order=id.asc&limit=500&id=gt.${UUID}`],
    ['GET', `/rest/v1/sales?select=*%2Csale_items%28*%29&shop_id=eq.${UUID}&order=id.asc&limit=500`],
    ['GET', `/rest/v1/sales?select=request_id&id=eq.${UUID}&shop_id=eq.${UUID}`],
    ['GET', '/rest/v1/sale_items?select=*'],
    ['HEAD', '/rest/v1/expenses?select=*'],
    ['POST', '/rest/v1/shops?select=id%2Cname%2Cowner_id'],
    ['PATCH', `/rest/v1/shops?id=eq.${UUID}&owner_id=eq.${UUID}`],
    ['POST', '/rest/v1/products?select=*'],
    ['PATCH', `/rest/v1/products?id=eq.${UUID}&shop_id=eq.${UUID}&updated_at=eq.2026-10-19T10%3A20%3A30.123456%2B00%3A00&select=*`],
    ['POST', '/rest/v1/expenses?select=*'],
    ['PATCH', `/rest/v1/expenses?id=eq.${UUID}&shop_id=eq.${UUID}&deleted_at=is.null&select=*`],
    ['POST', '/rest/v1/rpc/save_sale'],
    ['POST', '/rest/v1/rpc/void_sale'],
  ];
  for (const [method, path] of accepted) assert.equal((await f.request(path, { method, body: ['GET', 'HEAD'].includes(method) ? undefined : '{}' })).status, 200, `${method} ${path}`);
  for (const [method, path] of [['DELETE', '/rest/v1/products'], ['POST', '/rest/v1/sales'], ['PATCH', '/rest/v1/sale_items'], ['GET', '/rest/v1/rpc/save_sale'], ['DELETE', '/auth/v1/user']])
    assert.equal((await f.request(path, { method, body: method === 'GET' ? undefined : '{}' })).status, 405, `${method} ${path}`);
  assert.equal(f.calls.length, accepted.length);
});

test('inventory exposes only read tables and POST-only count/receive RPCs with unchanged bodies', async t => {
  const f = await fixture(t);
  const accepted = [
    ['GET', `/rest/v1/inventory_levels?select=*&shop_id=eq.${UUID}&order=id.asc&limit=500&id=gt.${UUID}`],
    ['HEAD', `/rest/v1/inventory_levels?select=*&id=eq.${UUID}&shop_id=eq.${UUID}`],
    ['GET', `/rest/v1/inventory_receipts?select=*&shop_id=eq.${UUID}&order=id.asc&limit=500&id=gt.${UUID}`],
    ['HEAD', `/rest/v1/inventory_receipts?select=*&id=eq.${UUID}`],
    ['POST', '/rest/v1/rpc/count_inventory', { p_product_id: UUID, p_quantity: 20, p_request_id: UUID, p_expected_quantity: null }],
    ['POST', '/rest/v1/rpc/receive_inventory', { p_id: UUID, p_product_id: UUID, p_business_date: '2026-10-24', p_quantity: 4, p_unit_cost_mills: 614, p_note: 'local mock only' }],
  ];
  for (const [method, path, body] of accepted) {
    assert.equal((await f.request(path, { method, body: body && JSON.stringify(body), headers: { authorization: `Bearer ${TOKEN}` } })).status, 200, `${method} ${path}`);
    const sent = f.received.at(-1);
    assert.equal(sent.method, method);
    assert.equal(sent.path, path);
    assert.equal(sent.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(sent.body, body ? JSON.stringify(body) : '');
  }
  for (const table of ['inventory_levels', 'inventory_receipts']) {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'])
      assert.equal((await f.request(`/rest/v1/${table}`, { method, body: '{}' })).status, 405, `${method} ${table}`);
    for (const query of ['select=id', 'select=*%2Cproducts%28*%29', 'order=created_at.desc', 'limit=501', 'limit=0', `shop_id=gt.${UUID}`, 'id=eq.anything', `product_id=eq.${UUID}`, 'or=%28id.eq.anything%29'])
      assert.equal((await f.request(`/rest/v1/${table}?${query}`)).status, 400, `${table}?${query}`);
  }
  for (const rpc of ['count_inventory', 'receive_inventory']) {
    for (const method of ['GET', 'HEAD', 'PATCH', 'PUT', 'DELETE'])
      assert.equal((await f.request(`/rest/v1/rpc/${rpc}`, { method, body: ['GET', 'HEAD'].includes(method) ? undefined : '{}' })).status, 405, `${method} ${rpc}`);
    assert.equal((await f.request(`/rest/v1/rpc/${rpc}?arg=1`, { method: 'POST', body: '{}' })).status, 400);
  }
  for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'])
    assert.equal((await f.request('/rest/v1/inventory_counts', { method, body: ['GET', 'HEAD'].includes(method) ? undefined : '{}' })).status, 404, `${method} inventory_counts`);
  assert.equal(f.calls.length, accepted.length, 'denied inventory routes never contact upstream');
});

test('inventory preflights preserve exact read/write methods and never forward', async t => {
  const f = await fixture(t);
  for (const table of ['inventory_levels', 'inventory_receipts']) {
    const path = `/rest/v1/${table}?select=*&shop_id=eq.${UUID}&order=id.asc&limit=500`;
    const response = await f.request(path, { method: 'OPTIONS', headers: { 'access-control-request-method': 'GET', 'access-control-request-headers': 'apikey, authorization' } });
    assert.equal(response.status, 204);
    assert.equal(response.headers['access-control-allow-methods'], 'GET, HEAD');
    assert.equal((await f.request(`/rest/v1/${table}`, { method: 'OPTIONS', headers: { 'access-control-request-method': 'PATCH' } })).status, 405);
  }
  for (const rpc of ['count_inventory', 'receive_inventory']) {
    const response = await f.request(`/rest/v1/rpc/${rpc}`, { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'apikey, authorization, content-type' } });
    assert.equal(response.status, 204);
    assert.equal(response.headers['access-control-allow-methods'], 'POST');
  }
  assert.equal(f.calls.length, 0);
});

test('rejects absolute URLs, traversal, encoding tricks and non-whitelisted services', async t => {
  const f = await fixture(t);
  for (const path of [
    'http://evil.test/auth/v1/otp', '//evil.test/auth/v1/otp',
    '/auth/v1/../v1/otp', '/auth/v1/%6ftp', '/auth/v1/%2e%2e/admin',
    '/auth/v1/otp%2fadmin', '/auth/v1/otp\\admin', '/auth/v1/otp#admin',
    '/auth/v1/otp/', '/auth//v1/otp', '/auth/v1/otp@evil.test',
    '/auth/v1/admin/users', '/auth/v1/authorize', '/functions/v1/send-auth-sms',
    '/storage/v1/object', '/realtime/v1/websocket', '/rest/v1/users', '/rest/v1/rpc/arbitrary',
    '/rest/v1/constructor', '/auth/v1/__proto__',
  ]) {
    const result = await f.request(path);
    assert.ok([400, 404].includes(result.status), `${path}: ${result.status}`);
    assert.ok(!result.body.includes('evil.test'));
  }
  assert.equal(f.calls.length, 0);
});

test('does not trust incoming Host, including credential and suffix tricks', async t => {
  const f = await fixture(t);
  for (const host of ['evil.test', 'proxy.test.evil.test', 'proxy.test:9000', 'user@proxy.test', 'proxy.test/evil', 'proxy.test.', 'proxy.test,evil.test'])
    assert.equal((await f.request('/healthz', { headers: { host } })).status, 400, host);
  assert.equal(f.calls.length, 0);
  assert.throws(() => createProxyServer(), /PROXY_PUBLIC_HOSTS/);
  assert.throws(() => createProxyServer({ publicHosts: ['https://proxy.test'] }));
});

test('rejects arbitrary, duplicate, malformed and out-of-scope query parameters', async t => {
  const f = await fixture(t);
  for (const path of [
    '/rest/v1/shops?url=http%3A%2F%2Fevil.test', '/rest/v1/shops?apikey=secret',
    '/rest/v1/products?select=*&select=*', '/rest/v1/products?select=%ZZ',
    '/rest/v1/products?select=%FF', '/rest/v1/products?select=%252A',
    '/rest/v1/products?select=*%0A', '/rest/v1/products?select',
    '/rest/v1/products?limit=501', '/rest/v1/products?limit=0', '/rest/v1/products?limit=1e2',
    '/rest/v1/products?or=%28id.eq.anything%29', '/rest/v1/products?order=name.desc',
    '/rest/v1/shops?select=*%2Cusers%28*%29', '/rest/v1/sales?select=*%2Cshops%28*%29',
    '/rest/v1/products?id=eq.anything', '/rest/v1/products?shop_id=gt.anything',
    '/rest/v1/rpc/save_sale?arg=1', '/healthz?apikey=secret',
    '/auth/v1/token', '/auth/v1/token?grant_type=client_credentials',
    '/auth/v1/logout?scope=global', '/auth/v1/otp?phone=123',
    `/auth/v1/recover?redirect_to=${encodeURIComponent('https://evil.test/account/')}`,
    `/auth/v1/signup?redirect_to=${encodeURIComponent('https://user@lirunben.cn/account/')}`,
    `/auth/v1/signup?redirect_to=${encodeURIComponent(`${SITE}/account/?next=evil`)}`,
  ]) assert.equal((await f.request(path, { method: path.startsWith('/auth/') || path.startsWith('/rest/v1/rpc/') ? 'POST' : 'GET', body: path.startsWith('/auth/') || path.startsWith('/rest/v1/rpc/') ? '{}' : undefined })).status, 400, path);
  assert.equal(f.calls.length, 0);
});

test('rejects non-publishable API keys, privileged bearer keys and duplicate credential headers', async t => {
  const f = await fixture(t);
  for (const apikey of [undefined, '', 'sb_secret_mock', TOKEN])
    assert.equal((await f.request('/auth/v1/otp', { method: 'POST', body: '{}', headers: { apikey } })).status, 401);
  const privileged = `e30.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.mock`;
  for (const authorization of ['Basic mock', 'Bearer sb_secret_mock', `Bearer ${privileged}`, ['Bearer mock', 'Bearer second']])
    assert.equal((await f.request('/auth/v1/otp', { method: 'POST', body: '{}', headers: { authorization } })).status, 400);
  assert.equal((await f.request('/auth/v1/otp', { method: 'POST', body: '{}', headers: { apikey: [KEY, KEY] } })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('validates database profiles, ranges and Prefer before forwarding', async t => {
  const f = await fixture(t);
  for (const headers of [
    { 'accept-profile': 'private' }, { 'content-profile': 'auth' },
    { range: '0-500' }, { range: '20-1' }, { range: '0-' }, { 'range-unit': 'bytes' },
    { prefer: 'tx=rollback' }, { prefer: 'return=representation, arbitrary=value' },
  ]) assert.equal((await f.request('/rest/v1/products', { headers })).status, 400);
  const valid = await f.request('/rest/v1/products', { headers: { 'accept-profile': 'public', 'range-unit': 'items', range: '0-499', prefer: 'count=exact' } });
  assert.equal(valid.status, 200);
  assert.equal(f.calls.length, 1);
});

test('preserves upstream status, errors and useful headers while forcing no-store', async t => {
  const f = await fixture(t, { handler: (_req, res) => {
    res.writeHead(429, {
      'content-type': 'application/json', 'retry-after': '60', 'x-request-id': 'mock-request',
      'content-range': '0-0/1', 'range-unit': 'items', 'preference-applied': 'count=exact',
      'cache-control': 'public, max-age=9999', etag: 'mock', 'set-cookie': 'upstream=private',
      'access-control-allow-origin': '*',
    });
    res.end('{"error":"mock_rate_limit"}');
  } });
  const result = await f.request('/auth/v1/otp', { method: 'POST', body: '{}' });
  assert.equal(result.status, 429);
  assert.equal(result.body, '{"error":"mock_rate_limit"}');
  assert.equal(result.headers['retry-after'], '60');
  assert.equal(result.headers['content-range'], '0-0/1');
  assert.equal(result.headers['x-request-id'], 'mock-request');
  assert.equal(result.headers['content-length'], String(Buffer.byteLength(result.body)));
  assert.match(result.headers['cache-control'], /private, no-store/);
  assert.equal(result.headers.pragma, 'no-cache');
  assert.equal(result.headers.expires, '0');
  assert.equal(result.headers.etag, undefined);
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.headers['access-control-allow-origin'], SITE);
  assert.equal(f.calls.length, 1);
});

test('does not cache GET responses across requests', async t => {
  let count = 0;
  const f = await fixture(t, { handler: (_req, res) => res.end(JSON.stringify({ request: ++count })) });
  assert.equal(JSON.parse((await f.request('/rest/v1/shops')).body).request, 1);
  assert.equal(JSON.parse((await f.request('/rest/v1/shops')).body).request, 2);
  assert.equal(f.calls.length, 2);
});

test('never retries OTP, RPC writes, or GET on upstream server and network failures', async t => {
  const f = await fixture(t, { handler: (_req, res) => { res.statusCode = 503; res.end('mock failure'); } });
  for (const [method, path] of [['POST', '/auth/v1/otp'], ['POST', '/rest/v1/rpc/save_sale'], ['POST', '/rest/v1/rpc/count_inventory'], ['POST', '/rest/v1/rpc/receive_inventory'], ['GET', '/rest/v1/shops']]) {
    const before = f.calls.length;
    const result = await f.request(path, { method, body: method === 'POST' ? '{}' : undefined });
    assert.equal(result.status, 503);
    assert.equal(f.calls.length, before + 1);
  }
  const failure = await fixture(t, { fetchImpl: async () => { throw new Error('mock secret-bearing error must never escape'); } });
  const result = await failure.request('/auth/v1/otp', { method: 'POST', body: '{}' });
  assert.equal(result.status, 502);
  assert.equal(result.body, '{"error":"upstream_unavailable"}');
  assert.equal(failure.calls.length, 1);
});

test('does not follow upstream redirects', async t => {
  const f = await fixture(t, { handler: (_req, res) => {
    res.writeHead(302, { location: '/should-never-be-fetched' }); res.end();
  } });
  const result = await f.request('/auth/v1/otp', { method: 'POST', body: '{}' });
  assert.equal(result.status, 502);
  assert.equal(result.headers.location, undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.received.length, 1);
});

test('enforces declared and chunked request size limits before calling upstream', async t => {
  const f = await fixture(t, { maxBodyBytes: 128 });
  const large = JSON.stringify({ content: 'x'.repeat(200) });
  assert.equal((await f.request('/auth/v1/otp', { method: 'POST', headers: { 'content-length': Buffer.byteLength(large) }, body: large })).status, 413);
  assert.equal((await f.request('/auth/v1/otp', { method: 'POST', chunks: ['{"value":"', 'x'.repeat(150), '"}'] })).status, 413);
  assert.equal(f.calls.length, 0);
});

test('rejects non-JSON, invalid JSON, compressed data, arrays and read request bodies', async t => {
  const f = await fixture(t);
  for (const [headers, body, status] of [
    [{ 'content-type': 'text/plain' }, '{}', 415],
    [{ 'content-encoding': 'gzip' }, '{}', 415],
    [{}, '{broken', 400], [{}, '[]', 400], [{}, 'null', 400], [{}, '', 400],
    [{}, Buffer.from([0xff]), 400],
  ]) assert.equal((await f.request('/auth/v1/otp', { method: 'POST', headers, body })).status, status);
  assert.equal((await f.request('/rest/v1/shops', { headers: { 'content-length': '2' }, body: '{}' })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('limits buffered response size and returns a credential-free error', async t => {
  const f = await fixture(t, { maxResponseBytes: 128, handler: (_req, res) => res.end('x'.repeat(256)) });
  const result = await f.request('/rest/v1/shops');
  assert.equal(result.status, 502);
  assert.equal(result.body, '{"error":"upstream_response_too_large"}');
  assert.equal(f.calls.length, 1);
});

test('applies upstream timeout without retrying or exposing exception details', async t => {
  const f = await fixture(t, { timeoutMs: 30, handler: (_req, _res) => {} });
  const result = await f.request('/auth/v1/otp', { method: 'POST', body: '{}' });
  assert.equal(result.status, 504);
  assert.equal(result.body, '{"error":"upstream_timeout"}');
  assert.equal(f.calls.length, 1);
});

test('handles empty 204 and HEAD responses without emitting body or stale content length', async t => {
  const f = await fixture(t, { handler: (req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': '123' }); res.end(); }
    else { res.statusCode = 204; res.end(); }
  } });
  const empty = await f.request('/auth/v1/logout?scope=local', { method: 'POST' });
  assert.equal(empty.status, 204);
  assert.equal(empty.body, '');
  assert.equal(empty.headers['content-length'], undefined);
  const head = await f.request('/rest/v1/shops', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], undefined);
  assert.equal(f.calls.length, 2);
});
