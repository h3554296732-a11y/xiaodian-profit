import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDomain, issueCertificate, checkedState, checkedOrder, verifyPublicDns, safeDiagnostic } from './tls-order-flow.mjs';
import { API_DOMAIN, API_SUBDOMAIN_FLAG, DOMAIN, TLS_DIRECTORY, assertApprovals, csrOptions,
  dnsRecord, issuanceProfile, prepareKeyMaterial, safeErrorCode } from '../prepare-tls-certificate.mjs';
import { win32 } from 'node:path';

const base = 'https://acme-v02.api.letsencrypt.org/acme/';
const order = (status = 'pending', domain = DOMAIN) => ({ status, url: `${base}order/1/2`,
  finalize: `${base}finalize/1/2`, authorizations: [`${base}authz/3`],
  identifiers: [{ type: 'dns', value: domain }],
  ...(status === 'valid' ? { certificate: `${base}cert/4` } : {}) });
const state = (status = 'pending', domain = DOMAIN) => ({ version: 1, domain, binding: 'bound',
  accountUrl: `${base}acct/1`, phase: 'order', order: order(status, domain) });
function fixture(overrides = {}) {
  const domain = overrides.domain ?? DOMAIN;
  const calls = [], saved = [], controller = new AbortController();
  let current = 'pending', authorized = false;
  const client = {
    async createAccount(data) { calls.push(['account', data]); return { status: 'valid' }; },
    getAccountUrl() { return `${base}acct/1`; },
    async createOrder(data) { calls.push(['new', data]); return order('pending', domain); },
    async getOrder() { calls.push(['status']); return order(current, domain); },
    async getAuthorizations() { return [{ url: `${base}authz/3`,
      identifier: { type: 'dns', value: domain }, status: authorized ? 'valid' : 'pending',
      challenges: [{ type: 'dns-01', url: `${base}chall/3/4`, status: 'pending', token: 'a'.repeat(24) }] }]; },
    async getChallengeKeyAuthorization() { return 'x'.repeat(43); },
    async completeChallenge() { calls.push(['ca']); authorized = true; current = 'ready'; },
    async finalizeOrder() { calls.push(['finalize']); current = 'valid'; return order('valid', domain); },
    async getCertificate() { calls.push(['download']); return 'chain'; },
  };
  const args = { client, csr: 'public-csr', binding: 'bound', initialState: null, allowNew: true,
    async save(value) { saved.push(structuredClone(value)); },
    scope: { signal: controller.signal, check() { controller.signal.throwIfAborted(); }, async wait() {} },
    emit(record) { calls.push(['record', record]); },
    recordFor: (authz, challenge, value) => dnsRecord(authz, challenge, value, domain),
    async verifyDns(record) { calls.push(['dns', record]); }, async sleep() {}, ...overrides };
  return { args, calls, saved, client, controller, setStatus(value) { current = value; } };
}

test('approval gates accept only the two approvals and optional explicit order flag', () => {
  assert.throws(() => assertApprovals([]));
  assertApprovals(['--approved-le-terms-v1.8', '--approved-aliyun-import']);
  assertApprovals(['--approved-le-terms-v1.8', '--approved-aliyun-import', '--new-order-after-unrecoverable-failure']);
  assert.throws(() => assertApprovals(['--approved-le-terms-v1.8', '--approved-aliyun-import', '--unknown']));
});
test('no state and no explicit flag makes zero network calls', async () => {
  const f = fixture({ allowNew: false });
  await assert.rejects(issueCertificate(f.args), { safeCode: 'new_order_flag_required' });
  assert.equal(f.calls.length, 0);
});
test('creating, corrupt, foreign account/key and foreign URLs cannot create orders', async () => {
  for (const bad of [{ ...state(), phase: 'creating' }, { ...state(), binding: 'other' },
    { ...state(), version: 9 }, { ...state(), order: { ...order(), url: 'https://evil.test/acme/order' } }]) {
    const f = fixture({ initialState: bad });
    await assert.rejects(issueCertificate(f.args));
    assert.equal(f.calls.length, 0);
  }
  assert.throws(() => checkedOrder({ ...order(), identifiers: [{ type: 'dns', value: 'www.lirunben.cn' }] }));
  assert.throws(() => checkedState(null, 'bound'));
});
test('new order persists intent before creation; CA validation follows DNS precheck', async () => {
  const f = fixture();
  f.client.createOrder = async () => {
    assert.equal(f.saved.at(-1).phase, 'creating'); f.calls.push(['new']); return order();
  };
  assert.equal(await issueCertificate(f.args), 'chain');
  assert.deepEqual(f.calls[0], ['account', { onlyReturnExisting: true }]);
  assert.equal(f.calls.filter(([name]) => name === 'new').length, 1);
  assert.ok(f.calls.findIndex(([name]) => name === 'dns') < f.calls.findIndex(([name]) => name === 'ca'));
  assert.equal(f.saved.at(-1).order.status, 'valid');
});
test('lost new-order response leaves creating intent and is not retried', async () => {
  const f = fixture();
  f.client.createOrder = async () => { throw new Error('SECRET request body'); };
  await assert.rejects(issueCertificate(f.args), (error) => {
    assert.equal(error.diagnostic.stage, 'create_order');
    assert.ok(!JSON.stringify(error).includes('SECRET')); return true;
  });
  assert.equal(f.saved.at(-1).phase, 'creating');
});
test('DNS precheck failure never calls CA or deactivates authorization', async () => {
  const f = fixture({ async verifyDns() { throw new Error('failure'); } });
  await assert.rejects(issueCertificate(f.args), (error) => error.diagnostic.stage === 'dns_precheck');
  assert.ok(!f.calls.some(([name]) => name === 'ca'));
  assert.equal(f.saved.at(-1).phase, 'order');
});
test('pending order resumes without new order', async () => {
  const f = fixture({ initialState: state(), allowNew: false });
  await issueCertificate(f.args);
  assert.ok(!f.calls.some(([name]) => name === 'new'));
});
for (const status of ['ready', 'processing', 'valid']) {
  test(`${status} order resumes without DNS or new order`, async () => {
    const f = fixture({ initialState: state(status), allowNew: false });
    f.setStatus(status);
    if (status === 'processing') f.args.sleep = async () => f.setStatus('valid');
    await issueCertificate(f.args);
    assert.ok(!f.calls.some(([name]) => ['new', 'record', 'ca'].includes(name)));
  });
}
test('invalid and expired orders stop without replacement', async () => {
  for (const status of ['invalid', 'expired']) {
    const f = fixture({ initialState: state(), allowNew: true });
    f.client.getOrder = async () => ({ ...order(status === 'invalid' ? 'invalid' : 'pending'),
      ...(status === 'expired' ? { expires: '2000-01-01T00:00:00Z' } : {}) });
    await assert.rejects(issueCertificate(f.args), { safeCode: `order_${status}` });
    assert.ok(!f.calls.some(([name]) => name === 'new'));
  }
});
test('interruption prevents finalization and download', async () => {
  const f = fixture();
  f.args.verifyDns = async () => f.controller.abort(new Error('stopped'));
  await assert.rejects(issueCertificate(f.args));
  assert.ok(!f.calls.some(([name]) => ['ca', 'finalize', 'download'].includes(name)));
});
test('two independent HTTPS DNS results must contain exact TXT and owner name', async () => {
  const record = { name: '_acme-challenge.lirunben.cn', value: 'x'.repeat(43) };
  const controller = new AbortController();
  let count = 0;
  await verifyPublicDns(record, controller.signal, async () => {
    count += 1;
    const data = count === 1 ? record.value : `"${'x'.repeat(20)}" "${'x'.repeat(23)}"`;
    return { ok: true, async json() { return { Status: 0, Answer: [
      { type: 16, name: `${record.name}.`, data }] }; } };
  });
  assert.equal(count, 2);
  for (const wrong of ['wrong', `${record.value}extra`]) {
    await assert.rejects(verifyPublicDns(record, controller.signal, async () => ({ ok: true,
      async json() { return { Status: 0, Answer: [{ type: 16, name: record.name, data: JSON.stringify(wrong) }] }; } })),
    { safeCode: 'dns_not_ready' });
  }
});
test('error reporting retains only whitelisted metadata', () => {
  const report = safeDiagnostic({ message: 'SECRET', config: { privateKey: 'SECRET' },
    response: { status: 429, data: { type: 'urn:ietf:params:acme:error:rateLimited', detail: 'SECRET' } } }, 'create_order');
  assert.deepEqual(report, { error: 'operation_failed', stage: 'create_order', httpStatus: 429, acmeProblem: 'rateLimited' });
});

test('API CLI selection is fixed, explicit and compatible with the original approval flags', () => {
  const approvals = ['--approved-le-terms-v1.8', '--approved-aliyun-import'];
  assertApprovals([...approvals, API_SUBDOMAIN_FLAG]);
  assertApprovals([...approvals, API_SUBDOMAIN_FLAG, '--new-order-after-unrecoverable-failure']);
  for (const extra of ['--domain=api.lirunben.cn', '--domain=evil.test', '--directory=C:\\other'])
    assert.throws(() => assertApprovals([...approvals, extra]));
  assert.throws(() => assertApprovals([...approvals, API_SUBDOMAIN_FLAG, API_SUBDOMAIN_FLAG]));
  assert.throws(() => assertApprovals([API_SUBDOMAIN_FLAG]));
  assert.equal(issuanceProfile().domain, DOMAIN);
  assert.equal(issuanceProfile([API_SUBDOMAIN_FLAG]).domain, API_DOMAIN);
});

test('API certificate and order paths cannot overlap apex material; account, dependency base and lock are retained', () => {
  const apex = issuanceProfile();
  const before = JSON.stringify(apex);
  const api = issuanceProfile([API_SUBDOMAIN_FLAG]);
  assert.equal(apex.outputDirectory, TLS_DIRECTORY);
  assert.equal(api.outputDirectory, win32.join(TLS_DIRECTORY, API_DOMAIN));
  assert.equal(api.accountKeyPath, win32.join(TLS_DIRECTORY, 'account-key.pem'));
  assert.equal(api.accountKeyPath, apex.accountKeyPath);
  assert.equal(api.lockPath, apex.lockPath);
  assert.equal(api.lockPath, win32.join(TLS_DIRECTORY, 'issuance.lock'));
  assert.equal(apex.requireExistingAccount, false);
  assert.equal(api.requireExistingAccount, true);
  assert.deepEqual(Object.keys(api.paths).sort(), ['certificate-metadata.json', 'cert.pem', 'fullchain.pem', 'order-state.json', 'privkey.pem'].sort());
  for (const [name, path] of Object.entries(api.paths)) {
    assert.equal(path, win32.join(TLS_DIRECTORY, API_DOMAIN, name));
    assert.equal(apex.paths[name], win32.join(TLS_DIRECTORY, name));
    assert.notEqual(path, apex.paths[name]);
    assert.notEqual(path, api.accountKeyPath);
  }
  assert.equal(JSON.stringify(apex), before);
  assert.ok(Object.isFrozen(api) && Object.isFrozen(api.paths));
});

test('missing API account stops before loading ACME, creating any key or accessing other material', async () => {
  const calls = [];
  const api = issuanceProfile([API_SUBDOMAIN_FLAG]);
  const forbidden = () => { calls.push(['forbidden']); assert.fail('missing account must stop here'); };
  await assert.rejects(prepareKeyMaterial(api, { check() {} }, {
    async read(path, limit, privateFile) { calls.push(['read', path, limit, privateFile]); return null; },
    validate: forbidden, load: forbidden, key: forbidden,
  }), error => safeErrorCode(error) === 'existing_account_required');
  assert.deepEqual(calls, [['read', api.accountKeyPath, 16384, true]]);
});

test('API reuses its existing account read-only and generates only the isolated certificate key', async () => {
  const api = issuanceProfile([API_SUBDOMAIN_FLAG]);
  const apex = issuanceProfile();
  // An in-memory file map: this test never reads or writes filesystem keys.
  const files = new Map([[api.accountKeyPath, 'mock-existing-account'], ...Object.entries(apex.paths).map(([name, path]) => [path, `mock-apex-${name}`])]);
  const before = new Map(files);
  const calls = [];
  const acme = { crypto: { async createPrivateRsaKey(size) { calls.push(['generate', size]); return Buffer.from('mock-api-certificate-key'); } } };
  const result = await prepareKeyMaterial(api, { check() {} }, {
    async read(path) { calls.push(['read', path]); return files.get(path) ?? null; },
    validate(value) { calls.push(['validate', value]); },
    async load() { calls.push(['load']); return acme; },
    async key(path, generate) { calls.push(['key', path]); const value = (await generate()).toString(); files.set(path, value); return value; },
  });
  assert.equal(result.accountKey, 'mock-existing-account');
  assert.equal(result.certificateKey, 'mock-api-certificate-key');
  assert.equal(result.acme, acme);
  assert.deepEqual(calls, [['read', api.accountKeyPath], ['validate', 'mock-existing-account'], ['load'], ['key', api.paths['privkey.pem']], ['generate', 2048]]);
  for (const [path, contents] of before) assert.equal(files.get(path), contents, path);
  assert.equal(files.size, before.size + 1);
});

test('invalid API account cannot fall back to generation or dependency loading', async () => {
  let laterCalls = 0;
  await assert.rejects(prepareKeyMaterial(issuanceProfile([API_SUBDOMAIN_FLAG]), { check() {} }, {
    async read() { return 'mock-invalid-account'; },
    validate() { throw new Error('mock invalid existing key'); },
    async load() { laterCalls += 1; }, async key() { laterCalls += 1; },
  }), /mock invalid existing key/);
  assert.equal(laterCalls, 0);
});

test('apex profile retains the original account and certificate-key loading sequence', async () => {
  const apex = issuanceProfile();
  const calls = [];
  const result = await prepareKeyMaterial(apex, { check() {} }, {
    async read() { assert.fail('apex retains the existing keyFile path'); },
    async load() { calls.push('load'); return { crypto: {} }; },
    async key(path) { calls.push(path); return `mock:${path}`; },
  });
  assert.deepEqual(calls, ['load', apex.accountKeyPath, apex.paths['privkey.pem']]);
  assert.equal(result.accountKey, `mock:${apex.accountKeyPath}`);
});

test('CSR and DNS record helpers permit only the selected fixed domain', () => {
  assert.deepEqual(csrOptions(), { keySize: 2048, altNames: [DOMAIN] });
  assert.deepEqual(csrOptions(API_DOMAIN), { keySize: 2048, altNames: [API_DOMAIN] });
  const authz = { identifier: { type: 'dns', value: API_DOMAIN } };
  const challenge = { type: 'dns-01' };
  const record = dnsRecord(authz, challenge, 'x'.repeat(43), API_DOMAIN);
  assert.deepEqual(record, { name: `_acme-challenge.${API_DOMAIN}`, value: 'x'.repeat(43), domain: API_DOMAIN });
  assert.throws(() => dnsRecord(authz, challenge, 'x'.repeat(43)));
  assert.throws(() => dnsRecord({ identifier: { type: 'dns', value: DOMAIN } }, challenge, 'x'.repeat(43), API_DOMAIN));
  for (const domain of ['www.lirunben.cn', '*.lirunben.cn', 'api.lirunben.cn.evil.test', 'API.LIRUNBEN.CN', 'evil.test']) {
    assert.throws(() => assertDomain(domain));
    assert.throws(() => csrOptions(domain));
  }
});

test('cross-domain state and order reuse is rejected before any account or network call', async () => {
  for (const [domain, initialState] of [
    [API_DOMAIN, state('pending', DOMAIN)],
    [DOMAIN, state('pending', API_DOMAIN)],
    [API_DOMAIN, { ...state('pending', API_DOMAIN), order: order('pending', DOMAIN) }],
  ]) {
    const f = fixture({ domain, initialState });
    await assert.rejects(issueCertificate(f.args), { safeCode: 'state_invalid' });
    assert.equal(f.calls.length, 0);
    assert.equal(f.saved.length, 0);
  }
  assert.throws(() => checkedOrder(order('pending', API_DOMAIN)));
  assert.throws(() => checkedOrder(order(), API_DOMAIN));
  assert.throws(() => checkedState(state('pending', API_DOMAIN), 'bound'));
});

test('API order, state, DNS challenge and finalization stay bound to the API domain', async () => {
  const f = fixture({ domain: API_DOMAIN });
  assert.equal(await issueCertificate(f.args), 'chain');
  assert.deepEqual(f.calls[0], ['account', { onlyReturnExisting: true }]);
  assert.deepEqual(f.calls.find(([name]) => name === 'new')[1], { identifiers: [{ type: 'dns', value: API_DOMAIN }] });
  assert.ok(f.saved.every(saved => saved.domain === API_DOMAIN));
  assert.ok(f.saved.filter(saved => saved.order).every(saved => saved.order.identifiers[0].value === API_DOMAIN));
  assert.equal(f.calls.filter(([name]) => name === 'new').length, 1);
  assert.equal(f.calls.find(([name]) => name === 'record')[1].name, `_acme-challenge.${API_DOMAIN}`);
  assert.equal(f.calls.find(([name]) => name === 'dns')[1].domain, API_DOMAIN);
  assert.ok(f.calls.findIndex(([name]) => name === 'dns') < f.calls.findIndex(([name]) => name === 'ca'));
  assert.equal(f.saved.at(-1).order.status, 'valid');
});

test('API authorization cannot silently switch back to the apex', async () => {
  const f = fixture({ domain: API_DOMAIN, initialState: state('pending', API_DOMAIN), allowNew: false });
  const original = f.client.getAuthorizations;
  f.client.getAuthorizations = async () => (await original()).map(value => ({ ...value, identifier: { type: 'dns', value: DOMAIN } }));
  await assert.rejects(issueCertificate(f.args), { safeCode: 'state_invalid' });
  assert.ok(!f.calls.some(([name]) => ['new', 'record', 'dns', 'ca', 'finalize', 'download'].includes(name)));
});

test('API public DNS precheck requires exact API TXT in both independent mock resolvers', async () => {
  const record = { name: `_acme-challenge.${API_DOMAIN}`, value: 'x'.repeat(43) };
  const controller = new AbortController();
  const urls = [];
  const resolver = async (url, options) => {
    urls.push(url);
    assert.equal(url.searchParams.get('name'), record.name);
    assert.equal(options.redirect, 'error');
    return { ok: true, async json() { return { Status: 0, Answer: [{ type: 16, name: `${record.name}.`, data: JSON.stringify(record.value) }] }; } };
  };
  await verifyPublicDns(record, controller.signal, resolver, API_DOMAIN);
  assert.equal(urls.length, 2);
  assert.deepEqual(urls.map(url => url.origin).sort(), ['https://cloudflare-dns.com', 'https://dns.google']);
  let wrongDomainCalls = 0;
  await assert.rejects(verifyPublicDns({ ...record, name: `_acme-challenge.${DOMAIN}` }, controller.signal, async () => { wrongDomainCalls += 1; }, API_DOMAIN), { safeCode: 'dns_record_invalid' });
  assert.equal(wrongDomainCalls, 0);
  await assert.rejects(verifyPublicDns(record, controller.signal, async () => ({ ok: true, async json() { return { Status: 0, Answer: [{ type: 16, name: `_acme-challenge.${DOMAIN}.`, data: JSON.stringify(record.value) }] }; } }), API_DOMAIN), { safeCode: 'dns_not_ready' });
});

test('API flow default DNS verifier is bound to API without live requests', async t => {
  const names = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const name = url.searchParams.get('name');
    names.push(name);
    return { ok: true, async json() { return { Status: 0, Answer: [{ type: 16, name: `${name}.`, data: 'x'.repeat(43) }] }; } };
  });
  const f = fixture({ domain: API_DOMAIN, verifyDns: undefined });
  f.client.completeChallenge = async () => {
    assert.deepEqual(names, [`_acme-challenge.${API_DOMAIN}`, `_acme-challenge.${API_DOMAIN}`]);
    f.calls.push(['ca']); f.setStatus('ready');
    f.client.getAuthorizations = async () => [{ url: `${base}authz/3`, identifier: { type: 'dns', value: API_DOMAIN }, status: 'valid' }];
  };
  assert.equal(await issueCertificate(f.args), 'chain');
  assert.equal(names.length, 2);
});

test('API existing order resumes without new creation and unknown profile cannot access the client', async () => {
  const resume = fixture({ domain: API_DOMAIN, initialState: state('valid', API_DOMAIN), allowNew: false });
  resume.setStatus('valid');
  assert.equal(await issueCertificate(resume.args), 'chain');
  assert.ok(!resume.calls.some(([name]) => ['new', 'record', 'dns', 'ca', 'finalize'].includes(name)));
  const unknown = fixture({ domain: 'evil.test' });
  await assert.rejects(issueCertificate(unknown.args), { safeCode: 'state_invalid' });
  assert.equal(unknown.calls.length, 0);
});

function dnsFallbackFixture(answerFor = () => [['x'.repeat(43)]]) {
  const record = { name: `_acme-challenge.${API_DOMAIN}`, value: 'x'.repeat(43) };
  const calls = [];
  const createResolver = (options) => {
    const call = { options, servers: [], names: [], cancellations: 0 };
    calls.push(call);
    return {
      setServers(servers) { call.servers = servers; },
      resolveTxt(name) { call.names.push(name); return answerFor(call); },
      cancel() { call.cancellations += 1; },
    };
  };
  return { record, calls, createResolver };
}
const unreachableDoh = async () => { throw new TypeError('mock transport unavailable'); };

test('DoH transport failures fall back to exact TXT on both fixed independent DNS servers', async () => {
  const f = dnsFallbackFixture((call) => Promise.resolve(call.servers[0] === '8.8.8.8'
    ? [['x'.repeat(20), 'x'.repeat(23)]] : [['unrelated'], ['x'.repeat(43)]]));
  let httpsCalls = 0;
  await verifyPublicDns(f.record, new AbortController().signal, async () => {
    httpsCalls += 1;
    if (httpsCalls === 1) return { ok: true, async json() { return { Status: 0, Answer: [
      { type: 16, name: `${f.record.name}.`, data: JSON.stringify(f.record.value) }] }; } };
    return unreachableDoh();
  }, API_DOMAIN, { createResolver: f.createResolver });
  assert.equal(httpsCalls, 2);
  assert.deepEqual(f.calls.map(call => call.servers), [['8.8.8.8'], ['1.1.1.1']]);
  for (const call of f.calls) {
    assert.deepEqual(call.options, { timeout: 3000, tries: 1 });
    assert.deepEqual(call.names, [f.record.name]);
    assert.ok(call.cancellations >= 1);
  }
});

test('one wrong or missing independent fallback TXT fails the entire precheck', async () => {
  for (const bad of [[['wrong']], [], [['x'.repeat(44)]]]) {
    const f = dnsFallbackFixture(call => Promise.resolve(call.servers[0] === '8.8.8.8'
      ? [[f.record.value]] : bad));
    await assert.rejects(verifyPublicDns(f.record, new AbortController().signal, unreachableDoh,
      API_DOMAIN, { createResolver: f.createResolver }), { safeCode: 'dns_not_ready' });
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every(call => call.cancellations >= 1));
  }
});

test('HTTP errors and explicit negative or wrong DoH answers cannot trigger UDP fallback', async () => {
  const record = { name: `_acme-challenge.${API_DOMAIN}`, value: 'x'.repeat(43) };
  const bodies = [
    { Status: 3 }, { Status: 0, Answer: [] },
    { Status: 0, Answer: [{ type: 16, name: record.name, data: 'wrong' }] },
    { Status: 0, Answer: [{ type: 16, name: `_acme-challenge.${DOMAIN}`, data: record.value }] },
  ];
  for (const response of [{ ok: false }, ...bodies.map(body => ({ ok: true, async json() { return body; } }))]) {
    let count = 0, resolverCalls = 0;
    await assert.rejects(verifyPublicDns(record, new AbortController().signal, async () => {
      count += 1;
      if (count === 1) return response;
      return unreachableDoh();
    }, API_DOMAIN, { createResolver() { resolverCalls += 1; assert.fail('negative DoH must stop'); } }),
    { safeCode: 'dns_not_ready' });
    assert.equal(count, 2);
    assert.equal(resolverCalls, 0);
  }
  let resolverCalls = 0;
  await assert.rejects(verifyPublicDns(record, new AbortController().signal, async () => ({
    ok: true, async json() { throw new SyntaxError('mock malformed DNS JSON'); },
  }), API_DOMAIN, { createResolver() { resolverCalls += 1; assert.fail('bad JSON must stop'); } }), SyntaxError);
  assert.equal(resolverCalls, 0);
});

test('already aborted DNS precheck makes no HTTPS or UDP requests', async () => {
  const f = dnsFallbackFixture();
  const controller = new AbortController();
  const stopped = new Error('mock operator stop');
  controller.abort(stopped);
  let httpsCalls = 0;
  await assert.rejects(verifyPublicDns(f.record, controller.signal,
    async () => { httpsCalls += 1; return unreachableDoh(); }, API_DOMAIN,
    { createResolver: f.createResolver }), error => error === stopped);
  assert.equal(httpsCalls, 0);
  assert.equal(f.calls.length, 0);
});

test('operator abort cancels both pending UDP queries and preserves the abort reason', async () => {
  const f = dnsFallbackFixture(() => new Promise(() => {}));
  const controller = new AbortController();
  const stopped = new Error('mock operator stop');
  const verification = verifyPublicDns(f.record, controller.signal, unreachableDoh,
    API_DOMAIN, { createResolver: f.createResolver });
  const rejection = assert.rejects(verification, error => error === stopped);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 2);
  controller.abort(stopped);
  await rejection;
  assert.ok(f.calls.every(call => call.cancellations >= 1));
});

test('bounded fallback timeout cancels unresolved queries and fails without waiting for DNS promises', async () => {
  const f = dnsFallbackFixture(() => new Promise(() => {}));
  await assert.rejects(verifyPublicDns(f.record, new AbortController().signal, unreachableDoh,
    API_DOMAIN, { createResolver: f.createResolver, udpTimeoutMs: 20 }), { safeCode: 'dns_not_ready' });
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.cancellations >= 1));
});

test('one UDP resolver failure cancels its pending sibling and never treats transport as TXT success', async () => {
  const f = dnsFallbackFixture(call => call.servers[0] === '8.8.8.8'
    ? Promise.reject(new Error('mock DNS timeout')) : new Promise(() => {}));
  await assert.rejects(verifyPublicDns(f.record, new AbortController().signal, unreachableDoh,
    API_DOMAIN, { createResolver: f.createResolver }), { safeCode: 'dns_not_ready' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.cancellations >= 1));
});
