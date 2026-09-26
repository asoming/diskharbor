'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { contextFromEnvironment, describeFileContext, cloudPathReason } = require('../electron/file-context.cjs');
const { protectedPathReason } = require('../electron/cleanup.cjs');

const context = (platform, home, env = {}) => contextFromEnvironment({ platform, home, env });
const describe = (filePath, config, native) => describeFileContext({ path: filePath }, config, native);

test('application association uses bounded default roots on each platform with explicit evidence', () => {
  const cases = [
    ['linux', '/home/test', '/home/test/.config/google-chrome/Default/Cache/data', 'chrome', 'profile'],
    ['linux', '/home/test', '/home/test/.cache/mozilla/firefox/sample/cache2/entries/a', 'firefox', 'cache'],
    ['darwin', '/Users/test', '/Users/test/Library/Application Support/Firefox/Profiles/sample/prefs.js', 'firefox', 'profile'],
    ['darwin', '/Users/test', '/Users/test/Library/Caches/Google/Chrome/Default/Cache/a', 'chrome', 'cache'],
    ['win32', 'C:\\Users\\Test', 'c:\\users\\test\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\a', 'chrome', 'profile'],
    ['win32', 'C:\\Users\\Test', 'C:\\Users\\Test\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\sample\\prefs.js', 'firefox', 'profile'],
  ];
  for (const [platform, home, filePath, id, role] of cases) {
    const result = describe(filePath, context(platform, home));
    assert.equal(result.association.id, id);
    assert.equal(result.association.role, role);
    assert.equal(result.association.basis, 'known-location');
    assert.match(result.association.source, /^https:\/\//);
    assert.equal(result.cloud.status, 'unknown');
  }
});

test('custom environment roots are absolute and component matched; lookalikes stay unknown', () => {
  const config = context('linux', '/home/test', { CHROME_CONFIG_HOME: '/srv/profiles', XDG_CACHE_HOME: '/srv/cache' });
  assert.equal(describe('/srv/profiles/google-chrome/Default/file', config).association.id, 'chrome');
  assert.equal(describe('/srv/cache/chromium/Default/file', config).association.id, 'chromium');
  for (const filePath of ['/srv/profiles/google-chrome-copy/file', '/home/test/google-chrome/file', '/srv/profiles/Google-Chrome/file', '/srv/profiles/google-chrome/../other/file']) {
    assert.equal(describe(filePath, config).association, null, filePath);
  }
  const invalid = context('linux', '/home/test', { CHROME_CONFIG_HOME: '../escape', XDG_CACHE_HOME: '/tmp/bad\0path' });
  assert.equal(invalid.chromeConfigHome, '/home/test/.config');
  assert.equal(invalid.cacheHome, '/home/test/.cache');
});

test('cloud locations are suspected, never proof of provider installation or local bytes', () => {
  const config = context('win32', 'C:\\Users\\Test', { OneDrive: 'D:\\Synced' });
  const result = describe('d:\\synced\\Report.txt', config);
  assert.equal(result.cloud.status, 'suspected');
  assert.equal(result.cloud.basis, 'environment-root');
  assert.equal(result.native, null);
  assert.equal(cloudPathReason('D:\\SyncedCopy\\Report.txt', config), null);
  assert.equal(cloudPathReason('D:\\Synced\\Report.txt', config), 'CLOUD_LOCATION_PROTECTED');
  const mac = context('darwin', '/Users/test');
  assert.equal(describe('/Users/test/Library/CloudStorage/OtherProvider/file', mac).cloud.provider, null);
  assert.equal(describe('/Users/test/Dropbox/file', mac).cloud.basis, 'possible-location');
});

test('only verified native metadata describes residency; resident does not imply not synced', () => {
  const config = context('darwin', '/Users/test');
  const filePath = '/Users/test/OneDrive/file';
  const native = { source: 'native', platform: 'darwin', kind: 'file', cloudState: 'resident', hidden: false, system: false,
    reparsePoint: false, volume: { mountPath: '/', filesystem: 'apfs', local: true } };
  const result = describe(filePath, config, native);
  assert.equal(result.cloud.status, 'local');
  assert.equal(result.cloud.provider, 'OneDrive');
  assert.equal(result.native.hidden, false);
  assert.equal(result.native.volume.filesystem, 'apfs');
  assert.equal(describe(filePath, config, { ...native, cloudState: 'placeholder' }).cloud.status, 'placeholder');
  assert.equal(describe(filePath, config, { ...native, cloudState: 'unknown' }).cloud.status, 'suspected');
  assert.equal(describe(filePath, config, { cloudState: 'resident' }).cloud.status, 'suspected');
});

test('known cloud roots stay protected from cleanup even when a file is resident', () => {
  assert.equal(protectedPathReason('/home/test/OneDrive/report.txt', { platform: 'linux', home: '/home/test' }), 'CLOUD_LOCATION_PROTECTED');
  assert.equal(protectedPathReason('/home/test/Dropbox/report.txt', { platform: 'linux', home: '/home/test' }), 'CLOUD_LOCATION_PROTECTED');
  assert.equal(protectedPathReason('/home/test/Dropbox-copy/report.txt', { platform: 'linux', home: '/home/test' }), null);
  assert.equal(protectedPathReason('/Users/test/Library/CloudStorage/provider/file', { platform: 'darwin', home: '/Users/test' }), 'CLOUD_LOCATION_PROTECTED');
});
