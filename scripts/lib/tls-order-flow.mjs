// Explicit ACME DNS-01 flow. No network or file access occurs on import.
import { Resolver } from 'node:dns/promises';
export const NEW_ORDER_FLAG = '--new-order-after-unrecoverable-failure';
const DEFAULT_DOMAIN = 'lirunben.cn';
const DOMAINS = new Set([DEFAULT_DOMAIN, 'api.lirunben.cn']);
const ORIGIN = 'https://acme-v02.api.letsencrypt.org';
const STATES = new Set(['pending', 'ready', 'processing', 'valid', 'invalid']);
const PROBLEMS = new Set(['accountDoesNotExist', 'badNonce', 'caa', 'connection',
  'dns', 'incorrectResponse', 'malformed', 'orderNotReady', 'rateLimited',
  'rejectedIdentifier', 'serverInternal', 'unauthorized']);

export class FlowFailure extends Error {
  constructor(code) { super(code); this.safeCode = code; }
}
const reject = (code) => { throw new FlowFailure(code); };
export function assertDomain(domain) {
  if (!DOMAINS.has(domain)) reject('state_invalid');
  return domain;
}
function acmeUrl(value) {
  let url;
  try { url = new URL(value); } catch { reject('state_invalid'); }
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/acme/')
    || url.username || url.password || url.search || url.hash) reject('state_invalid');
  return url.href;
}
function identifier(item, domain) {
  if (item?.type !== 'dns' || item.value !== domain) reject('state_invalid');
  return { type: 'dns', value: domain };
}
export function checkedOrder(item, domain = DEFAULT_DOMAIN) {
  assertDomain(domain);
  if (!item || !STATES.has(item.status) || item.identifiers?.length !== 1
    || item.authorizations?.length !== 1) reject('state_invalid');
  const order = { url: acmeUrl(item.url), status: item.status,
    identifiers: [identifier(item.identifiers[0], domain)],
    authorizations: [acmeUrl(item.authorizations[0])], finalize: acmeUrl(item.finalize) };
  if (item.expires !== undefined) {
    if (!Number.isFinite(Date.parse(item.expires))) reject('state_invalid');
    order.expires = item.expires;
  }
  if (item.certificate) order.certificate = acmeUrl(item.certificate);
  return order;
}
export function checkedState(state, binding, domain = DEFAULT_DOMAIN) {
  assertDomain(domain);
  if (!state || state.version !== 1 || state.domain !== domain
    || state.binding !== binding || !['creating', 'order'].includes(state.phase)) reject('state_invalid');
  acmeUrl(state.accountUrl);
  if (state.phase === 'creating') reject('order_creation_uncertain');
  checkedOrder(state.order, domain);
  return state;
}
export function safeDiagnostic(error, stage) {
  const result = { error: error instanceof FlowFailure ? error.safeCode : 'operation_failed', stage };
  const status = error?.response?.status;
  if (Number.isInteger(status) && status >= 400 && status <= 599) result.httpStatus = status;
  const type = error?.response?.data?.type;
  if (typeof type === 'string' && type.startsWith('urn:ietf:params:acme:error:')) {
    const name = type.slice('urn:ietf:params:acme:error:'.length);
    if (PROBLEMS.has(name)) result.acmeProblem = name;
  }
  return result;
}
function txtValue(text) {
  if (typeof text === 'string' && /^[A-Za-z0-9_-]{43}$/.test(text)) return text;
  // DNS JSON TXT RDATA consists of one or more quoted strings.
  const chunks = text?.match(/"(?:[^"\\]|\\.)*"/g);
  if (!chunks || chunks.join(' ') !== text.trim()) return null;
  try { return chunks.map((chunk) => JSON.parse(chunk)).join(''); } catch { return null; }
}
async function verifyDnsTransportFallback(record, signal, createResolver, timeoutMs) {
  // These are the same two independent public providers as the HTTPS checks.
  // No caller-provided server, OS search suffix or hosts-file lookup is used.
  const servers = ['8.8.8.8', '1.1.1.1'];
  const deadline = new AbortController();
  const bounded = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(new FlowFailure('dns_not_ready')), timeoutMs);
  try {
    const results = await Promise.all(servers.map(async (server) => {
      bounded.throwIfAborted();
      const resolver = createResolver({ timeout: timeoutMs, tries: 1 });
      let onAbort;
      try {
        resolver.setServers([server]);
        const answers = await new Promise((resolve, rejectQuery) => {
          onAbort = () => {
            resolver.cancel();
            rejectQuery(bounded.reason);
          };
          bounded.addEventListener('abort', onAbort, { once: true });
          if (bounded.aborted) { onAbort(); return; }
          resolver.resolveTxt(record.name).then(resolve, rejectQuery);
        });
        return Array.isArray(answers) && answers.some((parts) => Array.isArray(parts)
          && parts.every((part) => typeof part === 'string') && parts.join('') === record.value);
      } finally {
        if (onAbort) bounded.removeEventListener('abort', onAbort);
        resolver.cancel();
      }
    }));
    bounded.throwIfAborted();
    if (!results.every(Boolean)) reject('dns_not_ready');
  } catch {
    signal.throwIfAborted();
    reject('dns_not_ready');
  } finally {
    clearTimeout(timer);
    // Cancel a sibling query too if the other one failed before the deadline.
    deadline.abort(new FlowFailure('dns_not_ready'));
  }
}
export async function verifyPublicDns(record, signal, fetchFn = fetch, domain = DEFAULT_DOMAIN, {
  createResolver = (options) => new Resolver(options), udpTimeoutMs = 3000,
} = {}) {
  assertDomain(domain);
  if (record.name !== `_acme-challenge.${domain}` || !/^[\w-]{43}$/.test(record.value)) reject('dns_record_invalid');
  if (!Number.isInteger(udpTimeoutMs) || udpTimeoutMs < 1 || udpTimeoutMs > 3000) reject('dns_record_invalid');
  signal.throwIfAborted();
  const endpoints = ['https://dns.google/resolve', 'https://cloudflare-dns.com/dns-query'];
  const results = await Promise.all(endpoints.map(async (endpoint) => {
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ name: record.name, type: 'TXT' }).toString();
    let response;
    try {
      response = await fetchFn(url, { headers: { accept: 'application/dns-json' },
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    } catch {
      signal.throwIfAborted();
      return 'transport_failure';
    }
    signal.throwIfAborted();
    if (!response.ok) return false;
    const body = await response.json();
    return body.Status === 0 && Array.isArray(body.Answer) && body.Answer.some((answer) =>
      answer.type === 16 && answer.name?.replace(/\.$/, '').toLowerCase() === record.name
      && txtValue(answer.data) === record.value);
  }));
  signal.throwIfAborted();
  // A received negative/mismatching result is authoritative for this precheck:
  // alternate transport must never override an explicit failed DNS answer.
  if (results.some((result) => result === false)) reject('dns_not_ready');
  if (results.every((result) => result === true)) return;
  await verifyDnsTransportFallback(record, signal, createResolver, udpTimeoutMs);
}

export async function issueCertificate({ client, csr, binding, initialState, allowNew,
  domain = DEFAULT_DOMAIN, save, scope, emit, recordFor,
  verifyDns = (record, signal) => verifyPublicDns(record, signal, fetch, domain),
  sleep = (ms) => new Promise((resolve, rejectSleep) => {
    const timer = setTimeout(done, ms);
    function done() { scope.signal.removeEventListener('abort', aborted); resolve(); }
    function aborted() { clearTimeout(timer); rejectSleep(scope.signal.reason); }
    scope.signal.addEventListener('abort', aborted, { once: true });
    if (scope.signal.aborted) aborted();
  }), now = Date.now }) {
  let stage = 'state';
  let state = initialState;
  const persist = async () => { scope.check(); await save(state); scope.check(); };
  const refresh = async () => {
    stage = 'order_status';
    state.order = checkedOrder(await client.getOrder(state.order), domain);
    await persist();
    if (state.order.status === 'invalid') reject('order_invalid');
    if (state.order.expires && Date.parse(state.order.expires) <= now()) reject('order_expired');
    return state.order.status;
  };
  const authz = async () => {
    stage = 'authorization';
    const all = await client.getAuthorizations(state.order);
    if (all.length !== 1 || all[0].wildcard === true) reject('authorization_invalid');
    const item = all[0];
    identifier(item.identifier, domain);
    if (acmeUrl(item.url) !== state.order.authorizations[0]) reject('authorization_invalid');
    if (!['pending', 'valid'].includes(item.status)) reject('authorization_invalid');
    const challenge = item.challenges?.find((entry) => entry.type === 'dns-01');
    if (item.status === 'pending' && (!challenge || !['pending', 'processing', 'valid'].includes(challenge.status)
      || !/^[\w-]{16,256}$/.test(challenge.token))) reject('authorization_invalid');
    state.authorization = { url: item.url, status: item.status };
    if (challenge) {
      acmeUrl(challenge.url);
      state.authorization.challenge = { type: 'dns-01', url: challenge.url,
        status: challenge.status, token: challenge.token };
    }
    await persist();
    return { item, challenge };
  };
  try {
    assertDomain(domain);
    if (state !== null) checkedState(state, binding, domain);
    else if (!allowNew) reject('new_order_flag_required');
    scope.check();
    stage = 'account_lookup';
    const account = await client.createAccount({ onlyReturnExisting: true });
    if (account.status !== 'valid') reject('account_invalid');
    const accountUrl = acmeUrl(client.getAccountUrl());
    if (state && state.accountUrl !== accountUrl) reject('state_invalid');
    if (!state) {
      state = { version: 1, domain, binding, accountUrl, phase: 'creating' };
      stage = 'order_intent';
      await persist(); // A lost create response must never trigger another order.
      stage = 'create_order';
      const order = await client.createOrder({ identifiers: [{ type: 'dns', value: domain }] });
      state.order = checkedOrder(order, domain);
      state.phase = 'order';
      await persist();
    }
    let status = await refresh();
    if (status === 'pending') {
      let authorization = await authz();
      if (authorization.item.status !== 'valid' && authorization.challenge.status === 'pending') {
        stage = 'dns_record';
        const value = await client.getChallengeKeyAuthorization(authorization.challenge);
        const record = recordFor(authorization.item, authorization.challenge, value);
        const ready = scope.wait();
        emit(record);
        stage = 'wait_dns';
        await ready;
        scope.check();
        stage = 'dns_precheck';
        await verifyDns(record, scope.signal);
        scope.check();
        stage = 'ca_challenge';
        await client.completeChallenge(authorization.challenge);
      }
      for (let attempt = 0; authorization.item.status !== 'valid'; attempt += 1) {
        if (attempt >= 24) reject('authorization_pending');
        await sleep(5000);
        scope.check();
        authorization = await authz();
      }
      status = await refresh();
    }
    for (let attempt = 0; status !== 'valid'; attempt += 1) {
      if (attempt >= 24) reject('order_pending');
      if (status === 'ready') {
        stage = 'finalize';
        state.order = checkedOrder(await client.finalizeOrder(state.order, csr), domain);
        await persist();
        if (state.order.status === 'invalid') reject('order_invalid');
      }
      await sleep(5000);
      scope.check();
      status = await refresh();
    }
    stage = 'download_certificate';
    scope.check();
    return await client.getCertificate(state.order);
  } catch (error) {
    const failure = new FlowFailure(error instanceof FlowFailure ? error.safeCode : 'operation_failed');
    failure.diagnostic = safeDiagnostic(error, stage);
    throw failure;
  }
}
