'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyPackagedSource } = require('./stable-release.cjs');
const { sha256 } = require('./stable-signatures.cjs');

(async () => {
  const root = path.resolve(__dirname, '..');
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert(/^\d+\.\d+\.\d+-alpha\.\d+$/.test(metadata.version), 'ALPHA_VERSION_REQUIRED');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '', 'CLEAN_SOURCE_REQUIRED');
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const directory = path.join(root, 'release', metadata.version);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const extension = { linux: ['.deb', '.tar.gz'], win32: ['.exe'], darwin: ['.dmg'] }[process.platform];
  assert(extension, 'UNSUPPORTED_PLATFORM');
  let appPath = path.join(directory, process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked');
  if (process.platform === 'darwin') {
    const apps = [];
    for (const entry of entries.filter(item => item.isDirectory())) {
      const candidate = path.join(directory, entry.name, 'DiskHarbor.app');
      if ((await fs.stat(candidate).catch(() => null))?.isDirectory()) apps.push(candidate);
    }
    assert.equal(apps.length, 1, 'EXACT_APP_REQUIRED');
    [appPath] = apps;
  }
  const packagedSource = await verifyPackagedSource(root, appPath, process.platform, metadata.version);
  const artifacts = entries.filter(item => item.isFile() && extension.some(ext => item.name.endsWith(ext)));
  assert.equal(artifacts.length, extension.length, 'EXACT_ARTIFACT_SET_REQUIRED');
  const target = `${process.platform}-${process.arch}`;
  const output = path.join(root, 'release', `preview-${target}`);
  await fs.mkdir(output); // Never merge old and new build evidence.
  const report = { version: metadata.version, sourceSha, platform: process.platform, arch: process.arch,
    distribution: 'unsigned-prerelease', permissionDialogs: 'user-feedback', packagedSource, artifacts: [] };
  for (const artifact of artifacts) {
    const ext = extension.find(value => artifact.name.endsWith(value));
    const file = `DiskHarbor-${metadata.version}-${target}${ext}`;
    const original = path.join(directory, artifact.name);
    assert(!(await fs.lstat(original)).isSymbolicLink(), 'REGULAR_ARTIFACT_REQUIRED');
    await fs.copyFile(original, path.join(output, file), fs.constants.COPYFILE_EXCL);
    const hash = await sha256(original);
    assert.equal(await sha256(path.join(output, file)), hash, 'COPY_MISMATCH');
    report.artifacts.push({ file, sha256: hash, bytes: (await fs.stat(original)).size });
  }
  await fs.writeFile(path.join(output, `build-${target}.json`), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(output, `SHA256SUMS-${target}.txt`), report.artifacts.map(item => `${item.sha256}  ${item.file}\n`).join(''));
  console.log(`${target}: packaged source, licenses and installer hashes verified.`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
