'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { requireHostedCI, ownedChild, firefoxProfileRoots, sha256 } = require('../scripts/validation-common.cjs');
const { packageFiles, connectCDP, upgradeHistory, UPGRADE_BASE_SHA, UPGRADE_BASE_VERSION, pngDimensions } = require('../scripts/package-validation.cjs');
const { safeHistoryItem } = require('../electron/history.cjs');
const { snapshot } = require('../scripts/browser-cache-validation.cjs');

test('installation validation refuses personal, self-hosted and non-opted-in environments', () => {
  const allowed = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', DISKHARBOR_RELEASE_VALIDATION: '1', RUNNER_TEMP: path.resolve('temp') };
  assert.doesNotThrow(() => requireHostedCI(allowed));
  for (const changed of [{}, { ...allowed, GITHUB_ACTIONS: 'false' }, { ...allowed, RUNNER_ENVIRONMENT: 'self-hosted' }, { ...allowed, DISKHARBOR_RELEASE_VALIDATION: undefined }, { ...allowed, RUNNER_TEMP: 'relative' }]) assert.throws(() => requireHostedCI(changed), /HOSTED_CI_REQUIRED/);
});
test('owned-child fence rejects a parent, sibling and directory itself', () => {
  const root = path.resolve('owned');
  assert.equal(ownedChild(root, path.join(root, 'app', 'file')), path.join(root, 'app', 'file'));
  for (const target of [root, path.dirname(root), path.resolve('owned-neighbor', 'file'), path.join(root, '..', 'escape')]) assert.throws(() => ownedChild(root, target), /OUTSIDE_OWNED_DIRECTORY/);
});
test('artifact selection refuses ambiguous executables and unexpected platform', () => {
  assert.equal(packageFiles(['DiskHarbor Setup.exe', 'latest.yml'], 'win32'), 'DiskHarbor Setup.exe');
  assert.equal(packageFiles(['diskharbor.deb', 'diskharbor.tar.gz'], 'linux'), 'diskharbor.deb');
  assert.equal(packageFiles(['DiskHarbor.dmg'], 'darwin'), 'DiskHarbor.dmg');
  assert.throws(() => packageFiles(['a.exe', 'b.exe'], 'win32'), /AMBIGUOUS/);
  assert.throws(() => packageFiles(['folder/a.exe'], 'win32'), /AMBIGUOUS/);
  assert.throws(() => packageFiles([], 'other'), /UNSUPPORTED_PLATFORM/);
});
test('Firefox expected paths use real platform default root/local separation', () => {
  assert.deepEqual(firefoxProfileRoots('linux', '/home/ci', {}), { root: '/home/ci/.mozilla/firefox', local: '/home/ci/.cache/mozilla/firefox' });
  assert.deepEqual(firefoxProfileRoots('linux', '/home/ci', { XDG_CACHE_HOME: '/cache' }), { root: '/home/ci/.mozilla/firefox', local: '/cache/mozilla/firefox' });
  assert.deepEqual(firefoxProfileRoots('darwin', '/Users/ci', {}), { root: '/Users/ci/Library/Application Support/Firefox/Profiles', local: '/Users/ci/Library/Caches/Firefox/Profiles' });
  assert.deepEqual(firefoxProfileRoots('win32', 'C:\\Users\\ci', { APPDATA: 'C:\\Users\\ci\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\ci\\AppData\\Local' }), { root: 'C:\\Users\\ci\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles', local: 'C:\\Users\\ci\\AppData\\Local\\Mozilla\\Firefox\\Profiles' });
  assert.throws(() => firefoxProfileRoots('win32', 'C:\\Users\\ci', {}), /UNAVAILABLE/);
});
test('packaged app debugging refuses non-loopback and insecure transport changes', async () => {
  await assert.rejects(connectCDP('ws://example.com:9222/devtools/browser/x'), /CDP_MUST_BE_LOOPBACK/);
  await assert.rejects(connectCDP('wss://127.0.0.1:9222/devtools/browser/x'), /CDP_MUST_BE_LOOPBACK/);
});
test('upgrade uses the same published alpha.11 source in CI and validation with an honest cancelled history fixture', async () => {
  assert.equal(UPGRADE_BASE_SHA, '41eab5d9a2c2ddadd5ff71739df63a3197139024');
  assert.equal(UPGRADE_BASE_VERSION, '0.1.0-alpha.11');
  const workflow = await fs.readFile(path.resolve(__dirname, '../.github/workflows/release-validation.yml'), 'utf8');
  assert.equal(workflow.match(/^\s+ref: ([a-f0-9]{40})$/m)?.[1], UPGRADE_BASE_SHA);
  const value = upgradeHistory(path.resolve('owned-fixture'));
  assert.deepEqual(safeHistoryItem(value), value);
  assert.equal(value.success, 0); assert.equal(value.cancelled, 1);
  assert.equal(value.items[0].status, 'cancelled'); assert.equal(value.spaceMeasurement.status, 'not-run');
  assert.match(value.id, /^synthetic-upgrade-/); assert.equal(value.freeSpaceDelta, null);
});
test('icon evidence rejects missing or oversized PNG headers', async () => {
  const icon = await fs.readFile(path.resolve(__dirname, '../assets/icon.png'));
  const dimensions = pngDimensions(icon); assert.ok(dimensions.width > 0 && dimensions.height > 0);
  assert.throws(() => pngDimensions(Buffer.alloc(24)), /INVALID_ICON_PNG/);
  const invalid = Buffer.from(icon); invalid.writeUInt32BE(100000, 16);
  assert.throws(() => pngDimensions(invalid), /INVALID_ICON_DIMENSIONS/);
});
test('owned cache snapshots measure real files, preserve a sentinel and reject links', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskharbor-release-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'entries')); await fs.writeFile(path.join(root, 'entries', 'payload'), Buffer.alloc(257));
  const sentinel = path.join(root, 'sentinel'); await fs.writeFile(sentinel, 'preserve me'); const before = await sha256(sentinel);
  assert.deepEqual(await snapshot(path.join(root, 'entries')), { files: 1, bytes: 257 });
  assert.deepEqual(await snapshot(path.join(root, 'missing')), { files: 0, bytes: 0 });
  assert.equal(await sha256(sentinel), before);
  if (process.platform !== 'win32') { await fs.symlink(sentinel, path.join(root, 'entries', 'link')); await assert.rejects(snapshot(path.join(root, 'entries')), /UNEXPECTED_PROFILE_SYMLINK/); }
});
