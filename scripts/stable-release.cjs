'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { assertPreflight, STABLE_VERSION, SHA } = require('./release-preflight.cjs');
const { verifyWindows, verifyMac, sha256 } = require('./stable-signatures.cjs');

const TARGETS = ['linux-x64', 'win32-x64', 'darwin-arm64', 'darwin-x64'];
const EXPECTED_EXTENSIONS = { linux: ['.deb', '.tar.gz'], win32: ['.exe'], darwin: ['.dmg'] };
const digest = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

async function regularFile(file) {
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'REGULAR_ARTIFACT_REQUIRED');
  return stat;
}

async function locateBuild(root, platform, arch, version) {
  assert(TARGETS.includes(`${platform}-${arch}`), 'UNSUPPORTED_BUILD_TARGET');
  const directory = path.join(root, 'release/stable-build', `${platform}-${arch}`);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const expected = EXPECTED_EXTENSIONS[platform].map(ext => `DiskHarbor-${version}-${platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'}-${arch}${ext}`);
  const artifacts = entries.filter(entry => EXPECTED_EXTENSIONS[platform].some(ext => entry.name.endsWith(ext))).map(entry => entry.name).sort();
  assert.deepEqual(artifacts, [...expected].sort(), 'EXACT_ARTIFACT_SET_REQUIRED');
  for (const file of artifacts) await regularFile(path.join(directory, file));
  let appPath;
  if (platform === 'darwin') {
    const candidates = [];
    for (const entry of entries.filter(entry => entry.isDirectory())) {
      for (const app of await fs.readdir(path.join(directory, entry.name), { withFileTypes: true })) {
        if (app.name === 'DiskHarbor.app' && app.isDirectory()) candidates.push(path.join(directory, entry.name, app.name));
      }
    }
    assert.equal(candidates.length, 1, 'EXACT_MAC_APP_REQUIRED');
    appPath = candidates[0];
  } else appPath = path.join(directory, platform === 'win32' ? 'win-unpacked' : 'linux-unpacked');
  assert((await fs.lstat(appPath)).isDirectory(), 'UNPACKED_APP_REQUIRED');
  return { directory, appPath, artifacts };
}

async function verifyPackagedSource(root, appPath, platform, version) {
  const { extractFile } = require('@electron/asar');
  const resources = platform === 'darwin' ? path.join(appPath, 'Contents/Resources') : path.join(appPath, 'resources');
  const archive = path.join(resources, 'app.asar');
  await regularFile(archive);
  const packagedMetadata = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  assert.equal(packagedMetadata.version, version, 'PACKAGED_VERSION_MISMATCH');
  assert.equal(packagedMetadata.license, 'MIT', 'PACKAGED_LICENSE_MISMATCH');
  const licenses = ['LICENSE', 'THIRD_PARTY_LICENSES.txt'];
  for (const file of licenses) {
    const contents = await fs.readFile(path.join(root, file));
    assert(contents.length > 0, 'LICENSE_TEXT_REQUIRED');
    assert.equal(digest(extractFile(archive, file)), digest(contents), 'PACKAGED_LICENSE_TEXT_MISMATCH');
  }
  const source = execFileSync('git', ['ls-files', '-z', '--', 'electron'], { cwd: root, encoding: 'utf8' }).split('\0').filter(file => file.endsWith('.cjs'));
  const dist = [];
  async function add(directory) {
    for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await add(file);
      else { assert(entry.isFile(), 'UNEXPECTED_DIST_LINK'); dist.push(file); }
    }
  }
  await add('dist');
  assert(source.includes('electron/main.cjs') && dist.includes('dist/index.html'), 'PACKAGED_SOURCE_MISSING');
  for (const file of [...source, ...dist]) assert.equal(digest(extractFile(archive, path.normalize(file))), digest(await fs.readFile(path.join(root, file))), 'PACKAGED_SOURCE_MISMATCH');
  return { sourceFiles: source.length, rendererFiles: dist.length, license: 'MIT', licenseFiles: licenses, archiveSha256: await sha256(archive) };
}

async function verifyBuild(root, env = process.env) {
  const preflight = assertPreflight(root, env);
  const platform = process.platform; const arch = process.arch;
  const { directory, appPath, artifacts } = await locateBuild(root, platform, arch, preflight.version);
  const packagedSource = await verifyPackagedSource(root, appPath, platform, preflight.version);
  let signature = { method: 'SHA-256-integrity-only', codeSigning: 'not-applicable-on-this-linux-workflow' };
  if (platform === 'win32') signature = await verifyWindows({ appPath, artifact: path.join(directory, artifacts[0]), fingerprint: env.EXPECTED_WINDOWS_CERT_SHA256 });
  if (platform === 'darwin') signature = await verifyMac({ appPath, artifact: path.join(directory, artifacts[0]), teamId: env.APPLE_TEAM_ID, env });
  // Recheck HEAD and cleanliness after the build/tools and before issuing evidence.
  assert.deepEqual(assertPreflight(root, env), preflight, 'BUILD_SOURCE_CHANGED');
  const report = {
    schemaVersion: 1, result: 'verified-build-candidate', publication: 'not-published',
    acceptance: 'signing-and-build-only', version: preflight.version, sourceSha: preflight.sourceSha,
    platform, arch, osRelease: os.release(), runId: env.GITHUB_RUN_ID,
    packagedSource, signature, artifacts: [],
  };
  const parent = path.join(root, 'release/stable-verified');
  await fs.mkdir(parent, { recursive: true });
  const output = path.join(parent, `${platform}-${arch}`);
  await fs.mkdir(output); // Refuse to merge with old evidence or overwrite artifacts.
  for (const file of artifacts) {
    const source = path.join(directory, file);
    const hash = await sha256(source);
    await fs.copyFile(source, path.join(output, file), fs.constants.COPYFILE_EXCL);
    assert.equal(await sha256(path.join(output, file)), hash, 'ARTIFACT_COPY_CHANGED');
    report.artifacts.push({ file, bytes: (await regularFile(source)).size, sha256: hash });
  }
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), report.artifacts.map(item => `${item.sha256}  ${item.file}\n`).join(''), { flag: 'wx' });
  return report;
}

function validateReport(report, expected) {
  assert.equal(report?.schemaVersion, 1, 'INVALID_REPORT');
  assert.equal(report.result, 'verified-build-candidate', 'UNVERIFIED_REPORT');
  assert.equal(report.publication, 'not-published', 'INVALID_PUBLICATION_STATE');
  assert.equal(report.acceptance, 'signing-and-build-only', 'INVALID_ACCEPTANCE_SCOPE');
  assert(STABLE_VERSION.test(report.version), 'STABLE_VERSION_REQUIRED');
  assert.equal(report.version, expected.version, 'VERSION_MISMATCH');
  assert(SHA.test(report.sourceSha), 'SOURCE_SHA_REQUIRED');
  assert.equal(report.sourceSha, expected.sourceSha, 'SOURCE_SHA_MISMATCH');
  assert.equal(report.runId, expected.runId, 'WORKFLOW_RUN_MISMATCH');
  const target = `${report.platform}-${report.arch}`;
  assert(TARGETS.includes(target), 'UNSUPPORTED_BUILD_TARGET');
  assert(report.packagedSource?.sourceFiles > 0 && report.packagedSource.rendererFiles > 0 && /^[a-f0-9]{64}$/.test(report.packagedSource.archiveSha256), 'PACKAGED_SOURCE_EVIDENCE_REQUIRED');
  assert.equal(report.packagedSource.license, 'MIT', 'PACKAGED_LICENSE_MISMATCH');
  assert.deepEqual(report.packagedSource.licenseFiles, ['LICENSE', 'THIRD_PARTY_LICENSES.txt'], 'PACKAGED_LICENSE_TEXT_MISSING');
  const signature = report.signature;
  if (report.platform === 'win32') {
    assert.equal(signature?.method, 'Authenticode-and-SignTool', 'WINDOWS_SIGNATURE_EVIDENCE_REQUIRED');
    assert(Array.isArray(signature.signatures) && signature.signatures.length >= 4, 'WINDOWS_SIGNATURE_EVIDENCE_REQUIRED');
    for (const item of signature.signatures) {
      assert.equal(item.status, 'Valid', 'WINDOWS_SIGNATURE_EVIDENCE_REQUIRED');
      assert.equal(item.certSha256, expected.windowsFingerprint.toUpperCase(), 'WINDOWS_SIGNER_MISMATCH');
      assert(/^[A-F0-9]{64}$/.test(item.timestampCertSha256), 'WINDOWS_TIMESTAMP_REQUIRED');
    }
  } else if (report.platform === 'darwin') {
    assert.equal(signature?.method, 'Developer-ID-notarytool-stapler-Gatekeeper', 'MAC_SIGNATURE_EVIDENCE_REQUIRED');
    assert.equal(signature.teamId, expected.macTeamId, 'MAC_TEAM_MISMATCH');
    for (const field of ['developerId', 'timestamp', 'hardenedRuntime', 'appTicket', 'artifactTicket']) assert.equal(signature[field], true, 'MAC_SIGNATURE_EVIDENCE_REQUIRED');
    assert.equal(signature.notaryStatus, 'Accepted', 'MAC_NOTARIZATION_REQUIRED');
    assert.equal(signature.gatekeeper, 'accepted', 'MAC_GATEKEEPER_REQUIRED');
    assert(signature.nativeBinariesVerified >= 3, 'MAC_NATIVE_SIGNATURES_REQUIRED');
  } else assert.equal(signature?.method, 'SHA-256-integrity-only', 'LINUX_INTEGRITY_EVIDENCE_REQUIRED');
  assert(Array.isArray(report.artifacts) && report.artifacts.length === EXPECTED_EXTENSIONS[report.platform].length, 'EXACT_ARTIFACT_SET_REQUIRED');
  const osName = report.platform === 'win32' ? 'win' : report.platform === 'darwin' ? 'mac' : 'linux';
  assert.deepEqual(report.artifacts.map(item => item.file).sort(), EXPECTED_EXTENSIONS[report.platform].map(ext => `DiskHarbor-${report.version}-${osName}-${report.arch}${ext}`).sort(), 'EXACT_ARTIFACT_SET_REQUIRED');
  for (const artifact of report.artifacts) {
    assert(typeof artifact.file === 'string' && /^[A-Za-z0-9._-]+$/.test(artifact.file) && artifact.file !== '.' && artifact.file !== '..', 'UNSAFE_ARTIFACT_NAME');
    assert(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0 && /^[a-f0-9]{64}$/.test(artifact.sha256), 'INVALID_ARTIFACT_DIGEST');
  }
  return target;
}

async function collectReports(directory, expected) {
  const reports = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  assert.equal(entries.length, TARGETS.length, 'ALL_FOUR_TARGETS_REQUIRED');
  for (const entry of entries) {
    assert(entry.isDirectory(), 'REPORT_DIRECTORY_REQUIRED');
    const folder = path.join(directory, entry.name);
    await regularFile(path.join(folder, 'report.json'));
    const report = JSON.parse(await fs.readFile(path.join(folder, 'report.json'), 'utf8'));
    const target = validateReport(report, expected);
    assert(!reports.some(item => `${item.platform}-${item.arch}` === target), 'DUPLICATE_TARGET');
    for (const item of report.artifacts) {
      const file = path.join(folder, item.file);
      assert.equal((await regularFile(file)).size, item.bytes, 'ARTIFACT_SIZE_MISMATCH');
      assert.equal(await sha256(file), item.sha256, 'ARTIFACT_HASH_MISMATCH');
    }
    assert.equal(await fs.readFile(path.join(folder, 'SHA256SUMS.txt'), 'utf8'), report.artifacts.map(item => `${item.sha256}  ${item.file}\n`).join(''), 'CHECKSUM_MANIFEST_MISMATCH');
    reports.push(report);
  }
  assert.deepEqual(reports.map(report => `${report.platform}-${report.arch}`).sort(), [...TARGETS].sort(), 'ALL_FOUR_TARGETS_REQUIRED');
  return { schemaVersion: 1, result: 'all-build-candidates-verified', publication: 'not-published', acceptance: 'signing-and-build-only', ...expected, reports };
}

if (require.main === module) (async () => {
  const root = path.resolve(__dirname, '..');
  if (process.argv[2] === 'verify' && process.argv.length === 3) {
    const report = await verifyBuild(root);
    process.stdout.write(`${report.platform}-${report.arch}: verified build candidate; no publication performed.\n`);
  } else if (process.argv[2] === 'collect' && process.argv.length === 4) {
    // All private credentials were checked before the matrix. Aggregation only
    // needs the common source/version gates and the public expected identities.
    const preflight = assertPreflight(root, process.env, 'linux');
    const summary = await collectReports(path.resolve(process.argv[3]), {
      version: preflight.version, sourceSha: preflight.sourceSha, runId: process.env.GITHUB_RUN_ID,
      windowsFingerprint: process.env.EXPECTED_WINDOWS_CERT_SHA256, macTeamId: process.env.APPLE_TEAM_ID,
    });
    await fs.writeFile(path.join(root, 'release/stable-signing-manifest.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write('All four build candidates verified. Product acceptance and publication remain separate.\n');
  } else throw new Error('INVALID_STABLE_COMMAND');
})().catch(() => { process.stderr.write('STABLE_VERIFICATION_FAILED: no verified output may be published from this run.\n'); process.exitCode = 1; });

module.exports = { locateBuild, verifyPackagedSource, verifyBuild, validateReport, collectReports };
