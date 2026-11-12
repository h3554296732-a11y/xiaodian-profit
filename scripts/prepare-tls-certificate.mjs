/**
 * Reviewed, manually resumed DNS-01 issuance for the apex or fixed API domain.
 * Importing this module performs no file, network or key-generation operations.
 * Before execution, the operator must protect TLS_DIRECTORY with Windows ACLs.
 * No IIS changes, services, scheduled tasks, personal email or cloud API keys.
 */
import { createHash, createPrivateKey, createPublicKey, randomUUID, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { assertDomain, FlowFailure, issueCertificate, NEW_ORDER_FLAG } from './lib/tls-order-flow.mjs';

export const TLS_DIRECTORY = win32.join(homedir(), '.xiaodian-profit', 'tls');
export const DOMAIN = 'lirunben.cn';
export const API_DOMAIN = 'api.lirunben.cn';
export const API_SUBDOMAIN_FLAG = '--api-subdomain';
export const DIRECTORY_URL = 'https://acme-v02.api.letsencrypt.org/directory';
export const TERMS_URL = 'https://letsencrypt.org/documents/LE-SA-v1.8-July-06-2026.pdf';
export const CLIENT_VERSION = '5.4.0';
const APPROVAL_FLAGS = ['--approved-le-terms-v1.8', '--approved-aliyun-import'];
const execFileAsync = promisify(execFile);
const safeCodes = new Set([
  'approval_required', 'unsupported_argument', 'windows_required',
  'protected_directory_required', 'unsafe_file', 'file_write_failed',
  'invalid_existing_key', 'keys_must_be_distinct', 'client_version_mismatch',
  'client_unavailable', 'terms_changed', 'invalid_csr', 'dns_only',
  'invalid_dns_record', 'input_invalid', 'input_unexpected', 'input_too_long',
  'stdin_closed', 'interrupted', 'certificate_invalid', 'certificate_expired',
  'certificate_outputs_incomplete', 'certificate_metadata_mismatch', 'operation_failed',
  'state_invalid', 'order_creation_uncertain', 'new_order_flag_required',
  'order_invalid', 'order_expired', 'account_invalid', 'authorization_invalid',
  'dns_record_invalid', 'dns_not_ready', 'authorization_pending', 'order_pending',
  'issuance_locked', 'existing_account_required',
]);

class TlsFailure extends Error {
  constructor(code, diagnostic) { super(code); this.code = code; this.diagnostic = diagnostic; }
}
function fail(code) { throw new TlsFailure(code); }
export function safeErrorCode(error) {
  return error instanceof TlsFailure && safeCodes.has(error.code)
    ? error.code : 'operation_failed';
}

export function assertApprovals(argv) {
  // This must remain the first operation in run(): no dependency load or IO.
  if (!APPROVAL_FLAGS.every((flag) => argv.includes(flag))) fail('approval_required');
  if (new Set(argv).size !== argv.length || argv.length > 4
    || argv.some((flag) => ![...APPROVAL_FLAGS, NEW_ORDER_FLAG, API_SUBDOMAIN_FLAG].includes(flag))) {
    fail('unsupported_argument');
  }
}
export function issuanceProfile(argv = []) {
  // The CLI offers a fixed profile, never an operator-provided domain or path.
  const api = argv.includes(API_SUBDOMAIN_FLAG);
  const outputDirectory = api ? win32.join(TLS_DIRECTORY, API_DOMAIN) : TLS_DIRECTORY;
  const paths = Object.fromEntries(['privkey.pem', 'fullchain.pem', 'cert.pem', 'certificate-metadata.json', 'order-state.json']
    .map((name) => [name, win32.join(outputDirectory, name)]));
  return Object.freeze({
    domain: api ? API_DOMAIN : DOMAIN,
    requireExistingAccount: api,
    outputDirectory,
    accountKeyPath: win32.join(TLS_DIRECTORY, 'account-key.pem'),
    lockPath: win32.join(TLS_DIRECTORY, 'issuance.lock'),
    paths: Object.freeze(paths),
  });
}

export function csrOptions(domain = DOMAIN) {
  assertDomain(domain);
  return { keySize: 2048, altNames: [domain] };
}

export function dnsRecord(authz, challenge, value, domain = DOMAIN) {
  assertDomain(domain);
  if (challenge?.type !== 'dns-01') fail('dns_only');
  if (authz?.identifier?.type !== 'dns' || authz.identifier.value !== domain
    || authz.wildcard === true || typeof value !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(value)) fail('invalid_dns_record');
  // acme-client already hashes DNS-01 keyAuthorization; do not hash it again.
  return { name: `_acme-challenge.${domain}`, value, domain };
}

/** All input is JSON control input, never a password, private key or OTP. */
export function createInputScope(input, signals = process) {
  const controller = new AbortController();
  let pending;
  let buffered = '';
  let completed = false;
  const abort = (code) => {
    if (controller.signal.aborted || completed) return;
    controller.abort(new TlsFailure(code));
    if (pending) { const reject = pending.reject; pending = undefined; reject(controller.signal.reason); }
  };
  const onData = (chunk) => {
    const text = chunk.toString('utf8');
    if (text.includes('\u0003')) { abort('interrupted'); return; }
    buffered += text;
    if (buffered.length > 4096) { abort('input_too_long'); return; }
    let boundary;
    while ((boundary = buffered.search(/[\r\n]/)) >= 0) {
      const line = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 1);
      if (!line.trim()) continue;
      let command;
      try { command = JSON.parse(line); } catch { abort('input_invalid'); return; }
      if (!command || typeof command !== 'object' || Array.isArray(command)
        || Object.keys(command).length !== 1 || command.command !== 'dns_ready') {
        abort('input_invalid'); return;
      }
      if (!pending) { abort('input_unexpected'); return; }
      const accept = pending.resolve;
      pending = undefined;
      accept();
    }
  };
  const onClosed = () => abort('stdin_closed');
  const onSignal = () => abort('interrupted');
  input.on('data', onData);
  input.on('end', onClosed);
  input.on('close', onClosed);
  input.on('error', onClosed);
  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);
  input.resume();
  if (input.readableEnded || input.destroyed) abort('stdin_closed');
  return {
    signal: controller.signal,
    check() { if (controller.signal.aborted) throw controller.signal.reason; },
    wait() {
      if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
      if (pending) return Promise.reject(new TlsFailure('input_unexpected'));
      return new Promise((resolveInput, reject) => { pending = { resolve: resolveInput, reject }; });
    },
    abort,
    dispose() {
      completed = true;
      input.off('data', onData);
      input.off('end', onClosed);
      input.off('close', onClosed);
      input.off('error', onClosed);
      signals.off('SIGINT', onSignal);
      signals.off('SIGTERM', onSignal);
      input.pause();
    },
  };
}

export function assertAllowedAcl(acl, directory = false) {
  if (typeof acl?.sid !== 'string' || !/^S-1-5-\d+(?:-\d+)*$/.test(acl.sid)
    || !Array.isArray(acl.rules)) fail('protected_directory_required');
  const allowed = new Set([acl.sid, 'S-1-5-18', 'S-1-5-32-544']);
  const grants = acl.rules.filter((rule) => rule.type === 'Allow');
  if (!allowed.has(acl.owner) || (directory && !acl.protected)
    || grants.some((rule) => !allowed.has(rule.sid))
    || !grants.some((rule) => rule.sid === acl.sid && (rule.rights & 0x1f01ff) === 0x1f01ff)) {
    fail('protected_directory_required');
  }
}

async function assertAcl(path, directory = false) {
  // Read-only ACL inspection. The root task, not this helper, sets permissions.
  const pathLiteral = path.replaceAll("'", "''");
  // A parent pwsh 7 session may export an incompatible PSModulePath to Windows
  // PowerShell 5.1. Load only that child's bundled Windows modules for this read.
  const command = "$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\\Modules'; "
    + `$a=Get-Acl -LiteralPath '${pathLiteral}'; `
    + '$s=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; '
    + '$r=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | '
    + 'ForEach-Object { @{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();rights=[int64]$_.FileSystemRights} }); '
    + '@{sid=$s;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;rules=$r} | ConvertTo-Json -Compress -Depth 4';
  try {
    const result = await execFileAsync(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 15000, maxBuffer: 32768 },
    );
    const acl = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
    assertAllowedAcl(acl, directory);
  } catch { fail('protected_directory_required'); }
}

async function assertDirectory(directory = TLS_DIRECTORY) {
  if (process.platform !== 'win32') fail('windows_required');
  try {
    const info = await lstat(directory);
    const actual = await realpath(directory);
    if (!info.isDirectory() || info.isSymbolicLink()
      || actual.toLowerCase() !== directory.toLowerCase()) fail('protected_directory_required');
  } catch { fail('protected_directory_required'); }
  await assertAcl(directory, true);
}

async function readRegular(path, maxBytes = 131072, privateFile = false) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) fail('unsafe_file');
    if (privateFile) await assertAcl(path);
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof TlsFailure) throw error;
    fail('unsafe_file');
  }
}

async function writeExclusive(path, contents) {
  let file;
  try {
    file = await open(path, 'wx', 0o600);
    await file.writeFile(contents);
    await file.sync();
  } catch { fail('file_write_failed'); }
  finally { if (file) await file.close(); }
}

async function saveOrderState(path, state) {
  // All files inherit the protected directory ACL. Atomic replacement keeps the
  // previous complete state if a process is interrupted while writing.
  await readRegular(path, 32768, true);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeExclusive(temporary, `${JSON.stringify(state, null, 2)}\n`);
    await assertAcl(temporary);
    await rename(temporary, path);
    await assertAcl(path);
  } finally { await unlink(temporary).catch(() => {}); }
}

function validateKey(pem) {
  try {
    const key = createPrivateKey(pem);
    if (key.type !== 'private' || key.asymmetricKeyType !== 'rsa'
      || key.asymmetricKeyDetails.modulusLength < 2048) fail('invalid_existing_key');
    return key;
  } catch { fail('invalid_existing_key'); }
}

async function keyFile(path, generate, scope) {
  let pem = await readRegular(path, 16384, true);
  if (pem === null) {
    scope.check();
    pem = (await generate()).toString('utf8');
    validateKey(pem);
    scope.check();
    await writeExclusive(path, pem);
    await assertAcl(path);
  }
  validateKey(pem);
  return pem;
}

export function certificateMetadata(fullchain, privateKeyPem, now = Date.now(), domain = DOMAIN) {
  assertDomain(domain);
  try {
    const pieces = fullchain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!pieces || pieces.length < 2
      || fullchain.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim()) {
      fail('certificate_invalid');
    }
    const certificates = pieces.map((pem) => new X509Certificate(pem));
    const leaf = certificates[0];
    if (leaf.ca || leaf.subjectAltName !== `DNS:${domain}`
      || !leaf.checkPrivateKey(validateKey(privateKeyPem))) fail('certificate_invalid');
    for (let i = 0; i < certificates.length - 1; i += 1) {
      if (!certificates[i].checkIssued(certificates[i + 1])
        || !certificates[i].verify(certificates[i + 1].publicKey)) fail('certificate_invalid');
    }
    if (certificates.some((cert) => !Number.isFinite(Date.parse(cert.validTo))
      || Date.parse(cert.validTo) <= now || Date.parse(cert.validFrom) > now + 300000)) {
      fail('certificate_expired');
    }
    return {
      domain,
      san: [domain],
      notAfter: new Date(leaf.validTo).toISOString(),
      fingerprint256: leaf.fingerprint256,
    };
  } catch (error) {
    if (error instanceof TlsFailure) throw error;
    fail('certificate_invalid');
  }
}

export function assertExpectedMetadata(text, expected) {
  try {
    const actual = JSON.parse(text);
    const fields = ['domain', 'san', 'notAfter', 'fingerprint256'];
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)
      || Object.keys(actual).length !== fields.length
      || fields.some((field) => JSON.stringify(actual[field]) !== JSON.stringify(expected[field]))) {
      fail('certificate_metadata_mismatch');
    }
  } catch { fail('certificate_metadata_mismatch'); }
}

async function loadClient() {
  const packagePath = win32.join(TLS_DIRECTORY, 'node_modules', 'acme-client', 'package.json');
  try {
    const packageJson = JSON.parse(await readRegular(packagePath));
    if (packageJson.version !== CLIENT_VERSION) fail('client_version_mismatch');
    // pnpm links packages into node_modules/.pnpm. Resolve from the physical
    // package so its own dependencies resolve, while rejecting external links.
    const actualPackagePath = await realpath(packagePath);
    const relative = win32.relative(win32.join(TLS_DIRECTORY, 'node_modules'), actualPackagePath);
    if (!relative || relative === '..' || relative.startsWith('..\\') || win32.isAbsolute(relative)) {
      fail('client_unavailable');
    }
    const actualPackage = JSON.parse(await readRegular(actualPackagePath));
    if (actualPackage.version !== CLIENT_VERSION) fail('client_version_mismatch');
    const requireClient = createRequire(actualPackagePath);
    // A DEBUG=* environment must not enable raw third-party diagnostic output.
    requireClient('debug').disable();
    const acme = requireClient(win32.dirname(actualPackagePath));
    acme.setLogger(() => {});
    return acme;
  } catch (error) {
    if (error instanceof TlsFailure) throw error;
    fail('client_unavailable');
  }
}

export async function prepareKeyMaterial(profile, scope, {
  read = readRegular, validate = validateKey, load = loadClient, key = keyFile,
} = {}) {
  scope.check();
  let accountKey;
  if (profile.requireExistingAccount) {
    // Read-only reuse: a missing API account stops before dependency loading,
    // certificate-key generation or any ACME/DNS request. No fallback account.
    accountKey = await read(profile.accountKeyPath, 16384, true);
    if (accountKey === null) fail('existing_account_required');
    validate(accountKey);
    scope.check();
  }
  const acme = await load();
  scope.check();
  if (!profile.requireExistingAccount) {
    accountKey = await key(profile.accountKeyPath, () => acme.crypto.createPrivateRsaKey(2048), scope);
  }
  const certificateKey = await key(profile.paths['privkey.pem'], () => acme.crypto.createPrivateRsaKey(2048), scope);
  return { acme, accountKey, certificateKey };
}

export async function run(argv = process.argv.slice(2)) {
  assertApprovals(argv);
  const profile = issuanceProfile(argv);
  const { domain, paths, lockPath } = profile;
  await assertDirectory();
  if (profile.outputDirectory !== TLS_DIRECTORY) await assertDirectory(profile.outputDirectory);
  try { await writeExclusive(lockPath, `${process.pid}\n`); }
  catch { fail('issuance_locked'); }
  const scope = createInputScope(process.stdin);
  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    const { acme, accountKey, certificateKey } = await prepareKeyMaterial(profile, scope);
    if (validateKey(accountKey).export({ format: 'der', type: 'pkcs8' })
      .equals(validateKey(certificateKey).export({ format: 'der', type: 'pkcs8' }))) fail('keys_must_be_distinct');
    const existingChain = await readRegular(paths['fullchain.pem']);
    const existingCert = await readRegular(paths['cert.pem']);
    if (existingChain !== null) {
      const metadata = certificateMetadata(existingChain, certificateKey, Date.now(), domain);
      const savedMetadata = await readRegular(paths['certificate-metadata.json'], 4096);
      if (savedMetadata !== null) assertExpectedMetadata(savedMetadata, metadata);
      const leafPem = new X509Certificate(existingChain).toString();
      if (existingCert === null) {
        scope.check();
        await writeExclusive(paths['cert.pem'], `${leafPem}\n`);
        scope.check();
      }
      else if (new X509Certificate(existingCert).fingerprint256 !== metadata.fingerprint256) fail('certificate_invalid');
      if (savedMetadata === null) {
        scope.check();
        await writeExclusive(paths['certificate-metadata.json'], `${JSON.stringify(metadata, null, 2)}\n`);
        scope.check();
      }
      scope.check();
      emit(metadata);
      return metadata;
    }
    if (existingCert !== null) fail('certificate_outputs_incomplete');
    const stateText = await readRegular(paths['order-state.json'], 32768, true);
    let initialState = null;
    if (stateText !== null) {
      try { initialState = JSON.parse(stateText); } catch { fail('state_invalid'); }
      if (!initialState) fail('state_invalid');
    }
    if (initialState === null && !argv.includes(NEW_ORDER_FLAG)) fail('new_order_flag_required');
    const binding = createHash('sha256')
      .update(createPublicKey(accountKey).export({ format: 'der', type: 'spki' }))
      .update(createPublicKey(certificateKey).export({ format: 'der', type: 'spki' })).digest('hex');
    const [, csr] = await acme.crypto.createCsr(csrOptions(domain), certificateKey);
    const domains = acme.crypto.readCsrDomains(csr);
    if (domains.altNames?.length !== 1 || domains.altNames[0] !== domain
      || (domains.commonName && domains.commonName !== domain)) fail('invalid_csr');
    scope.check();
    acme.axios.defaults.signal = scope.signal;
    acme.axios.defaults.timeout = 30000;
    const client = new acme.Client({ directoryUrl: DIRECTORY_URL, accountKey });
    // A later agreement must be reviewed, never accepted by an old approval flag.
    if (await client.getTermsOfServiceUrl() !== TERMS_URL) fail('terms_changed');
    scope.check();
    const fullchain = await issueCertificate({
      domain, client, csr, binding, initialState, allowNew: argv.includes(NEW_ORDER_FLAG),
      save: (state) => saveOrderState(paths['order-state.json'], state),
      scope, emit, recordFor: (authz, challenge, value) => dnsRecord(authz, challenge, value, domain),
    });
    scope.check();
    const metadata = certificateMetadata(fullchain, certificateKey, Date.now(), domain);
    await writeExclusive(paths['fullchain.pem'], fullchain);
    scope.check();
    await writeExclusive(paths['cert.pem'], `${new X509Certificate(fullchain).toString()}\n`);
    scope.check();
    await writeExclusive(paths['certificate-metadata.json'], `${JSON.stringify(metadata, null, 2)}\n`);
    scope.check();
    emit(metadata);
    return metadata;
  } catch (error) {
    const code = scope.signal.aborted ? safeErrorCode(scope.signal.reason)
      : error instanceof FlowFailure && safeCodes.has(error.safeCode) ? error.safeCode : safeErrorCode(error);
    scope.abort(code);
    throw new TlsFailure(code, error instanceof FlowFailure ? error.diagnostic : undefined);
  } finally { scope.dispose(); await unlink(lockPath).catch(() => {}); }
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  run().catch((error) => {
    process.stderr.write(`${JSON.stringify(error.diagnostic ?? { error: safeErrorCode(error) })}\n`);
    process.exitCode = safeErrorCode(error) === 'interrupted' ? 130 : 1;
  });
}
