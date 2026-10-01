'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { preflight } = require('../scripts/release-preflight.cjs');
const { command, validateWindowsSignature, validateMacSignature, verifyMac, verifyWindows, sha256 } = require('../scripts/stable-signatures.cjs');
const { validateReport, collectReports, verifyPackagedSource } = require('../scripts/stable-release.cjs');

const sha = 'a'.repeat(40); const fingerprint = 'B'.repeat(64); const team = 'TEST123456';
function environment() {
  return {
    GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_EVENT_NAME: 'workflow_dispatch', DISKHARBOR_STABLE_BUILD: '1',
    RELEASE_VERSION: '1.0.0', RELEASE_SOURCE_SHA: sha, GITHUB_SHA: sha,
    WIN_CSC_LINK: 'synthetic-certificate-not-a-key', WIN_CSC_KEY_PASSWORD: 'synthetic-password', EXPECTED_WINDOWS_CERT_SHA256: fingerprint,
    CSC_LINK: 'synthetic-mac-certificate', CSC_KEY_PASSWORD: 'synthetic-mac-password',
    APPLE_ID: 'synthetic@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: 'synthetic-notary-password', APPLE_TEAM_ID: team,
  };
}
const check = (env, overrides = {}) => preflight({ env, metadata: { version: '1.0.0', license: 'MIT' }, actualSha: sha, ...overrides });

test('stable preflight requires exact committed stable version and every platform identity without exposing values', () => {
  const env = environment();
  assert.equal(check(env).ok, true);
  const missing = check({ ...env, WIN_CSC_LINK: '', CSC_KEY_PASSWORD: '', APPLE_APP_SPECIFIC_PASSWORD: '' });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['WIN_CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_APP_SPECIFIC_PASSWORD']);
  for (const value of ['synthetic-certificate-not-a-key', 'synthetic-password', 'synthetic@example.invalid']) assert(!JSON.stringify(missing).includes(value));
  for (const version of ['1.0.0-alpha.14', '1.0.0+build', '01.0.0', 'v1.0.0', '1.0']) assert.equal(check({ ...env, RELEASE_VERSION: version }, { metadata: { version } }).ok, false);
  assert.equal(check({ ...env, RELEASE_VERSION: '1.0.1' }).ok, false);
  assert.equal(check(env, { metadata: { version: '1.0.0', license: 'UNLICENSED' } }).ok, false);
});

test('preflight refuses wrong source, dirty checkout, PR, non-hosted and disabled signing', () => {
  const env = environment();
  for (const delta of [{ RELEASE_SOURCE_SHA: 'c'.repeat(40) }, { GITHUB_SHA: 'c'.repeat(40) }, { GITHUB_EVENT_NAME: 'pull_request' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { DISKHARBOR_STABLE_BUILD: '0' }, { EXPECTED_WINDOWS_CERT_SHA256: 'abc' }, { APPLE_TEAM_ID: 'ANY' }, { CSC_NAME: '-' }, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }]) assert.equal(check({ ...env, ...delta }).ok, false);
  assert.equal(check(env, { dirty: true }).ok, false);
  assert.equal(check(env, { platform: 'unsupported' }).ok, false);
  const linux = environment(); for (const key of ['WIN_CSC_LINK', 'CSC_LINK', 'APPLE_ID']) delete linux[key];
  assert.equal(check(linux, { platform: 'linux' }).ok, true);
  assert.equal(check(linux).ok, false);
});

test('dedicated builder config enforces native module signing, hardened runtime and no publishing', async () => {
  const text = await fs.readFile(path.join(__dirname, '../scripts/stable-builder.config.cjs'), 'utf8');
  let preflightCalls = 0;
  const base = { appId: 'io.diskharbor.desktop', asarUnpack: ['electron/native/**'], mac: { icon: 'icon.svg' }, win: { icon: 'icon.svg' }, directories: { output: 'preview' } };
  const context = { module: { exports: {} }, process: { platform: 'darwin', arch: 'arm64' }, __dirname: path.join(__dirname, '../scripts'), require(name) {
    if (name === './release-preflight.cjs') return { assertPreflight() { preflightCalls++; } };
    if (name === '../package.json') return { build: base };
    return require(name);
  } };
  vm.runInNewContext(text, context);
  const config = JSON.parse(JSON.stringify(context.module.exports));
  assert.equal(preflightCalls, 1);
  assert.equal(config.forceCodeSigning, true); assert.equal(config.publish, null);
  assert.equal(config.mac.notarize, true); assert.equal(config.mac.hardenedRuntime, true);
  assert(config.mac.binaries.every(item => item.startsWith('Contents/Resources/app.asar.unpacked/electron/native/darwin-arm64/')));
  assert.equal(config.win.requestedExecutionLevel, 'asInvoker');
  assert.deepEqual(config.win.signExts, ['.exe', '.dll', '.node']);
  assert.deepEqual(config.win.signtoolOptions.signingHashAlgorithms, ['sha256']);
  assert.deepEqual(config.asarUnpack, base.asarUnpack);
  assert.equal(base.directories.output, 'preview');
  await require('app-builder-lib/out/util/config/config').validateConfiguration(config, { isEnabled: false });
});

test('stable workflow is manual, read-only, never publishes, and gates aggregation on all four platforms', async () => {
  const { load } = require('js-yaml');
  const workflow = load(await fs.readFile(path.join(__dirname, '../.github/workflows/stable-release-build.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.build.needs, 'preflight');
  assert.equal(workflow.jobs.verify_all.needs, 'build');
  assert.equal(workflow.jobs.build.strategy.matrix.os.length, 4);
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.environment, 'stable-release');
    for (const step of job.steps) {
      if (step.run?.includes('npm run dist:')) assert(step.run.includes('--publish never'));
      assert(!step.run?.includes('gh release'));
      assert(!step.run?.includes('rm -'));
    }
  }
  assert(!JSON.stringify(workflow.jobs.verify_all.env).includes('secrets.'));
});

test('Windows verification rejects arbitrary, untrusted, catalog-only or untimestamped signatures', () => {
  const valid = { status: 'Valid', signatureType: 'Authenticode', certSha256: fingerprint, timestamp: true, timestampCertSha256: 'C'.repeat(64) };
  assert.equal(validateWindowsSignature(valid, fingerprint).status, 'Valid');
  for (const delta of [{ status: 'NotTrusted' }, { status: 'NotSigned' }, { signatureType: 'Catalog' }, { certSha256: 'D'.repeat(64) }, { timestamp: false }, { timestampCertSha256: null }]) assert.throws(() => validateWindowsSignature({ ...valid, ...delta }, fingerprint));
});

const macOutput = (hardened = true) => `Authority=Developer ID Application: Synthetic (${team})\nTeamIdentifier=${team}\nTimestamp=Oct 1, 2026 at 01:00:00\n${hardened ? 'CodeDirectory v=20500 size=999 flags=0x10000(runtime) hashes=1+7 location=embedded' : ''}\n`;
test('Mac verification rejects ad-hoc, wrong Team ID, development identity, absent timestamp or hardened runtime', () => {
  assert.equal(validateMacSignature(macOutput(), team, { hardened: true }).developerId, true);
  for (const output of [macOutput().replace(team, 'OTHER12345'), macOutput().replace('Developer ID Application', 'Apple Development'), macOutput().replace('Timestamp=', 'Unknown='), macOutput(false), `${macOutput()}Signature=adhoc\n`]) assert.throws(() => validateMacSignature(output, team, { hardened: true }));
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diskharbor-stable-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('ASAR verification binds application code, renderer, package license and both license texts', async t => {
  const dir = await fixture(t); const root = path.join(dir, 'source'); await fs.mkdir(root);
  const { execFileSync } = require('node:child_process');
  const asar = require('@electron/asar');
  for (const child of ['electron', 'dist']) await fs.mkdir(path.join(root, child));
  await fs.writeFile(path.join(root, 'electron/main.cjs'), 'module.exports = 1;');
  await fs.writeFile(path.join(root, 'dist/index.html'), '<main>Owned fixture</main>');
  await fs.mkdir(path.join(root, 'dist/assets'));
  await fs.writeFile(path.join(root, 'dist/assets/app.js'), 'console.log("Owned fixture");');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0', license: 'MIT' }));
  await fs.writeFile(path.join(root, 'LICENSE'), 'Owned synthetic MIT text');
  await fs.writeFile(path.join(root, 'THIRD_PARTY_LICENSES.txt'), 'Owned synthetic notices');
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', 'electron/main.cjs'], { cwd: root, stdio: 'ignore' });
  const app = path.join(dir, 'app'); await fs.mkdir(path.join(app, 'resources'), { recursive: true });
  await asar.createPackage(root, path.join(app, 'resources/app.asar'));
  const proof = await verifyPackagedSource(root, app, 'linux', '1.0.0');
  assert.equal(proof.license, 'MIT'); assert.equal(proof.sourceFiles, 1);
  assert.equal(proof.rendererFiles, 2);
  await fs.writeFile(path.join(root, 'dist/assets/app.js'), 'console.log("Changed fixture");');
  await assert.rejects(verifyPackagedSource(root, app, 'linux', '1.0.0'), /PACKAGED_SOURCE_MISMATCH/);
  await fs.writeFile(path.join(root, 'dist/assets/app.js'), 'console.log("Owned fixture");');
  assert.deepEqual(proof.licenseFiles, ['LICENSE', 'THIRD_PARTY_LICENSES.txt']);
  await assert.rejects(verifyPackagedSource(root, app, 'linux', '1.0.1'), /PACKAGED_VERSION_MISMATCH/);
  await fs.writeFile(path.join(root, 'THIRD_PARTY_LICENSES.txt'), 'Different text');
  await assert.rejects(verifyPackagedSource(root, app, 'linux', '1.0.0'), /PACKAGED_LICENSE_TEXT_MISMATCH/);
  await fs.writeFile(path.join(root, 'THIRD_PARTY_LICENSES.txt'), 'Owned synthetic notices');
  await fs.writeFile(path.join(root, 'electron/main.cjs'), 'module.exports = 2;');
  await assert.rejects(verifyPackagedSource(root, app, 'linux', '1.0.0'), /PACKAGED_SOURCE_MISMATCH/);
});

test('Windows verification actually schedules SignTool /pa /all /tw for installer and all PE/native files', async t => {
  const dir = await fixture(t); const app = path.join(dir, 'app'); await fs.mkdir(app);
  for (const file of ['DiskHarbor.exe', 'file-probe.exe', 'file-policy.node', 'library.dll', 'text.txt']) await fs.writeFile(path.join(app, file), 'owned fixture');
  const seen = [];
  const result = await verifyWindows({ appPath: app, artifact: path.join(dir, 'setup.exe'), fingerprint, run: async (exe, args, options) => {
    assert.equal(exe, 'pwsh'); assert(args.at(-1).includes('verify /pa /all /tw'));
    seen.push(options.env.DISKHARBOR_VERIFY_FILE);
    return JSON.stringify({ status: 'Valid', signatureType: 'Authenticode', certSha256: fingerprint, timestamp: true, timestampCertSha256: 'C'.repeat(64) });
  } });
  assert.equal(result.signatures.length, 5); assert.equal(seen.length, 5);
  assert(!seen.some(file => file.endsWith('.txt')));
  await assert.rejects(verifyWindows({ appPath: app, artifact: path.join(dir, 'setup.exe'), fingerprint, run: async () => { throw new Error('tool failure'); } }));
});

test('Mac final artifact must be Accepted, stapled, validated and assessed; rejection never becomes verified', async t => {
  const dir = await fixture(t); const app = path.join(dir, 'DiskHarbor.app'); await fs.mkdir(app);
  for (const name of ['file-probe', 'file-policy.node', 'DiskHarbor']) await fs.writeFile(path.join(app, name), Buffer.from('cffaedfe00000000', 'hex'));
  const artifact = path.join(dir, 'DiskHarbor.dmg');
  const calls = [];
  const run = async (exe, args) => {
    calls.push([exe, ...args]);
    if (args[0] === '--display') return macOutput();
    if (args[0] === 'notarytool') return JSON.stringify({ status: 'Accepted', id: '12345678-1234-1234-1234-123456789abc' });
    return '';
  };
  const value = await verifyMac({ appPath: app, artifact, teamId: team, env: environment(), run });
  assert.equal(value.gatekeeper, 'accepted'); assert.equal(value.nativeBinariesVerified, 3);
  assert(calls.some(args => args.includes('--deep')));
  assert(calls.some(args => args[1] === 'notarytool' && args.includes(artifact)));
  assert(calls.some(args => args[1] === 'stapler' && args[2] === 'validate' && args[3] === app));
  assert(calls.some(args => args.includes('context:primary-signature') && args.includes(artifact)));
  for (const failure of ['notarytool', 'stapler', '/usr/sbin/spctl']) await assert.rejects(verifyMac({ appPath: app, artifact, teamId: team, env: environment(), run: async (exe, args) => {
    if (args[0] === failure || exe === failure) {
      if (failure === 'notarytool') return JSON.stringify({ status: 'Invalid', id: '12345678-1234-1234-1234-123456789abc' });
      throw new Error('verification refused');
    }
    return run(exe, args);
  } }));
});

const expected = { version: '1.0.0', sourceSha: sha, runId: '123', windowsFingerprint: fingerprint, macTeamId: team };
function report(platform, arch) {
  const signature = platform === 'linux' ? { method: 'SHA-256-integrity-only' } : platform === 'win32' ? { method: 'Authenticode-and-SignTool', signatures: ['setup.exe', 'app.exe', 'helper.exe', 'addon.node'].map(file => ({ path: file, status: 'Valid', certSha256: fingerprint, timestampCertSha256: 'C'.repeat(64) })) } : { method: 'Developer-ID-notarytool-stapler-Gatekeeper', teamId: team, developerId: true, timestamp: true, hardenedRuntime: true, appTicket: true, artifactTicket: true, notaryStatus: 'Accepted', gatekeeper: 'accepted', nativeBinariesVerified: 3 };
  const osName = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
  const extensions = platform === 'linux' ? ['.deb', '.tar.gz'] : platform === 'win32' ? ['.exe'] : ['.dmg'];
  return { schemaVersion: 1, result: 'verified-build-candidate', publication: 'not-published', acceptance: 'signing-and-build-only', version: expected.version, sourceSha: sha, runId: '123', platform, arch, packagedSource: { sourceFiles: 2, rendererFiles: 2, license: 'MIT', licenseFiles: ['LICENSE', 'THIRD_PARTY_LICENSES.txt'], archiveSha256: 'd'.repeat(64) }, signature, artifacts: extensions.map(ext => ({ file: `DiskHarbor-1.0.0-${osName}-${arch}${ext}`, bytes: 1, sha256: 'e'.repeat(64) })) };
}

test('aggregate gate rejects wrong identity, incomplete notarization and stale version/source/run evidence', () => {
  for (const [platform, arch] of [['linux', 'x64'], ['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']]) assert.equal(validateReport(report(platform, arch), expected), `${platform}-${arch}`);
  for (const change of [{ result: 'failed' }, { sourceSha: 'c'.repeat(40) }, { runId: 'old' }, { version: '1.0.0-alpha.1' }, { packagedSource: null }]) assert.throws(() => validateReport({ ...report('linux', 'x64'), ...change }, expected));
  const win = report('win32', 'x64'); win.signature.signatures[1].certSha256 = 'A'.repeat(64); assert.throws(() => validateReport(win, expected));
  const mac = report('darwin', 'arm64'); mac.signature.artifactTicket = false; assert.throws(() => validateReport(mac, expected));
  const unsafe = report('linux', 'x64'); unsafe.artifacts[0].file = '../outside'; assert.throws(() => validateReport(unsafe, expected));
});

test('aggregate gate requires all four current-run reports and checks each downloaded package and checksum file', async t => {
  const dir = await fixture(t);
  for (const [platform, arch] of [['linux', 'x64'], ['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']]) {
    const folder = path.join(dir, `${platform}-${arch}`); await fs.mkdir(folder);
    const value = report(platform, arch);
    for (const item of value.artifacts) { const file = path.join(folder, item.file); await fs.writeFile(file, 'owned'); item.bytes = 5; item.sha256 = await sha256(file); }
    await fs.writeFile(path.join(folder, 'report.json'), JSON.stringify(value));
    await fs.writeFile(path.join(folder, 'SHA256SUMS.txt'), value.artifacts.map(item => `${item.sha256}  ${item.file}\n`).join(''));
  }
  const result = await collectReports(dir, expected); assert.equal(result.reports.length, 4); assert.equal(result.publication, 'not-published');
  await fs.writeFile(path.join(dir, 'linux-x64', report('linux', 'x64').artifacts[0].file), 'other');
  await assert.rejects(collectReports(dir, expected), /ARTIFACT_HASH_MISMATCH/);
  await fs.rm(path.join(dir, 'darwin-arm64'), { recursive: true });
  await assert.rejects(collectReports(dir, expected), /ALL_FOUR_TARGETS_REQUIRED/);
});

test('signature command errors never print credential-bearing output and timeout is bounded', async () => {
  await assert.rejects(command(process.execPath, ['-e', "process.stderr.write('synthetic-sensitive-value');process.exitCode=1"]), error => error.message === 'SIGNATURE_TOOL_REJECTED' && !error.message.includes('sensitive'));
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { timeout: 100 }), /SIGNATURE_TOOL_TIMEOUT/);
  assert.equal(await command(process.execPath, ['-e', "process.stdout.write('complete')"]), 'complete');
});
