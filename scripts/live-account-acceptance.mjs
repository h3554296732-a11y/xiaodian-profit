/**
 * Explicitly authorized production acceptance for disposable Gmail-alias accounts.
 * Passwords, email verification URLs and JWTs stay in memory, never in reports.
 * Requires hidden interactive stdin; does not read browser storage or admin keys.
 */
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const expectedOrigin = 'https://nporrbvnaezafvryjqao.supabase.co';
function parseSiteOrigin(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    // Require a canonical HTTPS origin, with no path, credentials, query or fragment.
    return url.protocol === 'https:' && url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}
const siteOrigin = parseSiteOrigin(process.env.QA_SITE_ORIGIN);
if (!siteOrigin) {
  console.error('FAIL QA_SITE_ORIGIN_required_https_root_origin');
  process.exit(1);
}
const origin = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (origin !== expectedOrigin || !key?.startsWith('sb_publishable_')) {
  console.error('FAIL public_configuration');
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error('FAIL hidden_interactive_stdin_required');
  process.exit(1);
}
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let inputBuffer = '';
const commands = [];
let resolveInput;
process.stdin.on('data', (chunk) => {
  if (chunk.includes('\u0003')) {
    process.stdin.setRawMode(false);
    process.exit(130);
  }
  inputBuffer += chunk;
  let index;
  while ((index = inputBuffer.search(/[\r\n]/)) >= 0) {
    const line = inputBuffer.slice(0, index);
    inputBuffer = inputBuffer.slice(index + 1);
    if (!line.trim()) continue;
    let command;
    try { command = JSON.parse(line); } catch { command = { command: 'invalid' }; }
    if (resolveInput) { const resolve = resolveInput; resolveInput = undefined; resolve(command); }
    else commands.push(command);
  }
});
function receive() {
  if (commands.length) return Promise.resolve(commands.shift());
  return new Promise((resolve) => { resolveInput = resolve; });
}
function emit(event, detail = {}) {
  process.stdout.write(JSON.stringify({ event, ...detail }) + '\n');
}
function safeCode(error) {
  return typeof error?.code === 'string' && /^[a-zA-Z0-9_]{1,50}$/.test(error.code)
    ? error.code : 'operation_failed';
}
function requireThat(condition, label) {
  if (!condition) throw Object.assign(new Error(label), { safeLabel: label });
}
function client() {
  return createClient(origin, key, { auth: {
    persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
    storageKey: `acceptance:${randomBytes(12).toString('hex')}`,
  }});
}
const tag = `xdqa-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${randomBytes(3).toString('hex')}`;
const reportPath = join('artifacts', `${tag}.json`);
const report = { tag, startedAt: new Date().toISOString(), project: 'nporrbvnaezafvryjqao', siteOrigin, status: 'running', auth: [], isolation: [], manifest: null };
const accounts = [];
async function persist() {
  await mkdir('artifacts', { recursive: true });
  // report contains only selected metadata/results, never SDK clients or auth replies.
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
async function record(label, passed, detail = {}) {
  report.auth.push({ label, passed, ...detail });
  await persist();
  emit(passed ? 'PASS' : 'FAIL', { label, ...detail });
}
async function authResult(label, promise) {
  const result = await promise;
  if (result.error) {
    await record(label, false, { code: safeCode(result.error) });
    throw Object.assign(new Error(label), { safeLabel: label, code: safeCode(result.error) });
  }
  return result.data;
}
async function confirmationSession(rawUrl, expectedType) {
  const url = new URL(rawUrl);
  requireThat(url.origin === expectedOrigin && url.pathname === '/auth/v1/verify', 'verification_url_origin');
  requireThat(url.searchParams.get('type') === expectedType && !!url.searchParams.get('token'), 'verification_url_type');
  const redirect = new URL(url.searchParams.get('redirect_to') ?? siteOrigin);
  requireThat(redirect.origin === siteOrigin && redirect.pathname === '/account/', 'verification_redirect_allowlist');
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  requireThat(response.status >= 300 && response.status < 400, 'verification_redirect_status');
  const location = new URL(response.headers.get('location') ?? 'about:blank');
  requireThat(location.origin === siteOrigin && location.pathname === '/account/', 'verification_return_to_live_site');
  const fragment = new URLSearchParams(location.hash.slice(1));
  requireThat(!fragment.has('error') && !!fragment.get('access_token') && !!fragment.get('refresh_token'), 'verification_creates_session');
  return { access_token: fragment.get('access_token'), refresh_token: fragment.get('refresh_token') };
}
async function main() {
  await persist();
  emit('ready', { tag });
  const approval = await receive();
  requireThat(approval.command === 'start' && typeof approval.mailbox === 'string' && /^[A-Za-z0-9.]+@gmail\.com$/.test(approval.mailbox), 'approved_mailbox');
  const approvedMailbox = approval.mailbox;
  const [local, domain] = approvedMailbox.split('@');
  let resumeA;
  if (approval.resumeTag) {
    requireThat(/^xdqa-\d{8}-[a-f0-9]{6}$/.test(approval.resumeTag), 'resume_tag');
    const previousPath = join('artifacts', `${approval.resumeTag}.json`);
    const previous = JSON.parse(await readFile(previousPath, 'utf8'));
    resumeA = previous.authAccounts?.find(a => a.label === 'A');
    requireThat(resumeA?.email === `${local}+${approval.resumeTag}-a@${domain}` && /^[0-9a-f-]{36}$/.test(resumeA.userId), 'resume_test_identity');
    requireThat(previous.auth.some(r=>r.label==='A_signup_requires_email'&&r.passed) && previous.auth.some(r=>r.label==='A_unconfirmed_login_denied'&&r.passed), 'resume_prior_signup_evidence');
    report.priorEvidence = { report: previousPath, checks: previous.auth.filter(r=>r.passed) };
  }
  for (const label of ['A','B']) {
    const resumed = label === 'A' && resumeA;
    const account = { label, email: resumed ? resumeA.email : `${local}+${tag}-${label.toLowerCase()}@${domain}`, password: `Qa9!${randomBytes(24).toString('base64url')}`, client: client(), ...(resumed ? {userId:resumeA.userId} : {}) };
    accounts.push(account);
    report.authAccounts = accounts.map(a => ({ label: a.label, email: a.email, userId: a.userId ?? null }));
    await persist();
    emit('recipient', { label, email: account.email });
    if (!resumed) {
      const data = await authResult(`${label}_signup_requires_email`, account.client.auth.signUp({ email: account.email, password: account.password, options: { emailRedirectTo: `${siteOrigin}/account/` } }));
      requireThat(data.user?.id && !data.session && data.user.identities?.length > 0, `${label}_new_unconfirmed_user`);
      account.userId = data.user.id;
      report.authAccounts = accounts.map(a => ({ label: a.label, email: a.email, userId: a.userId ?? null }));
      await record(`${label}_signup_requires_email`, true);
      const unconfirmed = await account.client.auth.signInWithPassword({ email: account.email, password: account.password });
      requireThat(unconfirmed.error?.code === 'email_not_confirmed', `${label}_unconfirmed_login_denied`);
      await record(`${label}_unconfirmed_login_denied`, true);
    } else await record('A_prior_signup_evidence_loaded', true);
    emit('await_confirmation', { label });
    const command = await receive();
    requireThat(command.command === 'confirm' && command.label === label, 'confirmation_command');
    const session = await confirmationSession(command.url, 'signup');
    await authResult(`${label}_email_session`, account.client.auth.setSession(session));
    const verified = await authResult(`${label}_verified_identity`, account.client.auth.getUser());
    requireThat(verified.user.id === account.userId && verified.user.email === account.email && !!verified.user.email_confirmed_at && !verified.user.is_anonymous, `${label}_confirmed_identity`);
    await record(`${label}_email_delivered_and_confirmed`, true);
    if (resumed) await authResult('A_resumed_test_password', account.client.auth.updateUser({password:account.password}));
    await authResult(`${label}_password_login`, account.client.auth.signInWithPassword({ email: account.email, password: account.password }));
    const refreshed = await authResult(`${label}_refresh_session`, account.client.auth.refreshSession());
    requireThat(refreshed.user?.id === account.userId, `${label}_refresh_identity`);
    await record(`${label}_password_login_and_refresh`, true);
  }
  requireThat(accounts[0].userId !== accounts[1].userId, 'distinct_real_auth_identities');
  emit('isolation_start');
  const { runLiveIsolation } = await import('./lib/live-isolation.mjs');
  const isolation = await runLiveIsolation({ accounts, tag,
    onResult: async (result) => { report.isolation.push(result); await persist(); emit(result.passed ? 'PASS' : 'FAIL', { label: result.label, ...(result.code ? { code: result.code } : {}) }); },
    onManifest: async (manifest) => { report.manifest = manifest; await persist(); },
  });
  report.manifest = isolation.manifest;
  report.isolation = isolation.results;
  await persist();
  const account = accounts[0];
  await authResult('A_recovery_email_request', account.client.auth.resetPasswordForEmail(account.email, { redirectTo: `${siteOrigin}/account/` }));
  emit('await_recovery', { label: 'A' });
  const command = await receive();
  requireThat(command.command === 'recover' && command.label === 'A', 'recovery_command');
  const recovery = client();
  const session = await confirmationSession(command.url, 'recovery');
  await authResult('A_recovery_session', recovery.auth.setSession(session));
  const recovered = await authResult('A_recovery_identity', recovery.auth.getUser());
  requireThat(recovered.user.id === account.userId, 'A_recovery_identity_matches');
  const oldPassword = account.password;
  account.password = `Qa9!${randomBytes(24).toString('base64url')}`;
  await authResult('A_password_reset', recovery.auth.updateUser({ password: account.password }));
  const oldLogin = client();
  const denied = await oldLogin.auth.signInWithPassword({ email: account.email, password: oldPassword });
  requireThat(denied.error?.code === 'invalid_credentials', 'A_old_password_denied');
  await oldLogin.auth.dispose();
  await authResult('A_new_password_login', account.client.auth.signInWithPassword({ email: account.email, password: account.password }));
  await record('A_recovery_delivered_reset_and_relogin', true);
  await recovery.auth.dispose();
  for (const a of accounts) {
    const { error } = await a.client.auth.signOut({ scope: 'global' });
    requireThat(!error, `${a.label}_logout`);
    const { data } = await a.client.auth.getSession();
    requireThat(data.session === null, `${a.label}_logout_no_session`);
    await a.client.auth.dispose();
    a.password = '';
  }
  await record('test_accounts_signed_out', true);
  report.status = 'passed';
  report.completedAt = new Date().toISOString();
  await persist();
  emit('done', { authChecks: report.auth.length, isolationChecks: report.isolation.length });
}
try { await main(); }
catch (error) {
  report.status = 'failed';
  report.failure = { label: error?.safeLabel ?? 'acceptance_failed', code: safeCode(error) };
  if (error?.manifest) report.manifest = error.manifest;
  if (error?.results) report.isolation = error.results;
  await persist().catch(() => {});
  emit('stopped', report.failure);
  for (const a of accounts) { await a.client.auth.signOut({ scope: 'global' }).catch(() => {}); await a.client.auth.dispose().catch(() => {}); a.password = ''; }
  process.exitCode = 1;
} finally {
  process.stdin.setRawMode(false);
  process.stdin.pause();
}
