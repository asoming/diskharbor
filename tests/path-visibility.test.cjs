'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isKnownSystemPath, createPathVisibility } = require('../electron/path-visibility.cjs');

test('Linux system roots use path boundaries and exclude removable media under /run/media', () => {
  const context = { platform: 'linux', home: '/home/sam' };
  for (const value of ['/usr', '/usr/lib/libexample.so', '/etc/settings', '/opt/app', '/run', '/run/user/1000', '/var/log']) {
    assert.equal(isKnownSystemPath(value, context), true, value);
  }
  for (const value of ['/usr-backup/file', '/home/sam/usr/file', '/projects/etc/settings',
    '/run/media', '/run/media/sam/drive/file', '/run/media-other/file/../../media/sam', '/home/sam/Projects']) {
    assert.equal(isKnownSystemPath(value, context), false, value);
  }
  assert.equal(isKnownSystemPath('/run/mediator/file', context), true);
});

test('Linux application data is anchored to the provided home and specific subdirectories', () => {
  const context = { platform: 'linux', home: '/home/sam' };
  for (const value of ['/home/sam/.cache/app', '/home/sam/.config/settings', '/home/sam/.local/share/app', '/home/sam/.local/state/app']) {
    assert.equal(isKnownSystemPath(value, context), true, value);
  }
  for (const value of ['/home/sam/.cache-backup/app', '/home/sam/project/.config/settings',
    '/home/other/.cache/app', '/home/sam/.local/bin/app', '/home/sam/.local/shared/app']) {
    assert.equal(isKnownSystemPath(value, context), false, value);
  }
});

test('classifying from / through /run preserves the /run/media exception for descendants', () => {
  const visibility = createPathVisibility('/', { platform: 'linux', home: '/home/sam' });
  const root = visibility.classify('/', '/', null);
  const run = visibility.classify('/run', 'run', root);
  assert.equal(run.systemPath, true);
  const media = visibility.classify('/run/media', 'media', run);
  assert.deepEqual(media, { hiddenPath: false, systemPath: false });
  const mounted = visibility.classify('/run/media/sam', 'sam', media);
  assert.equal(mounted.systemPath, false);
  assert.equal(visibility.classify('/run/media/sam/file.txt', 'file.txt', mounted).systemPath, false);
  assert.equal(visibility.classify('/run/mediator', 'mediator', run).systemPath, true);
  const hidden = visibility.classify('/run/media/sam/.private', '.private', mounted);
  assert.deepEqual(hidden, { hiddenPath: true, systemPath: false });
});

test('macOS Library paths are anchored to system locations, direct user homes or a trusted custom home', () => {
  const context = { platform: 'darwin', home: '/Volumes/Accounts/sam' };
  for (const value of ['/System/Library', '/Applications/Example.app', '/Library/Caches',
    '/Users/sam/Library', '/Users/other/Library/Caches', '/Volumes/Accounts/sam/Library/Caches']) {
    assert.equal(isKnownSystemPath(value, context), true, value);
  }
  for (const value of ['/Systematic/data', '/Users/sam/Library-copy', '/Users/sam/Projects/Library',
    '/Users/sam/folder/other/Library', '/Volumes/Accounts/other/Library', '/Volumes/Library']) {
    assert.equal(isKnownSystemPath(value, context), false, value);
  }
});

test('Windows rules require drive-root or trusted-home anchors and never guess UNC share layout', () => {
  const context = { platform: 'win32', home: 'D:\\Profiles\\sam' };
  for (const value of ['C:\\Windows\\System32', 'd:/PROGRAM FILES/App', 'C:\\Program Files (x86)\\App',
    'C:\\ProgramData\\App', 'C:\\Users\\sam\\AppData\\Local', 'e:/users/Other/appdata/Roaming',
    'D:\\Profiles\\sam\\AppData\\Local', 'C:\\$Recycle.Bin\\entry']) {
    assert.equal(isKnownSystemPath(value, context), true, value);
  }
  for (const value of ['C:\\Projects\\Windows\\file', 'C:\\Windows-old\\file',
    'C:\\Users\\sam\\AppData-old', 'C:\\Projects\\Users\\sam\\AppData',
    'D:\\Profiles\\other\\AppData', 'C:Windows\\file', '\\Windows\\file',
    '\\\\server\\share\\Windows\\file', '\\\\server\\share\\Users\\sam\\AppData',
    '\\\\?\\C:\\Windows\\file']) {
    assert.equal(isKnownSystemPath(value, context), false, value);
  }
  assert.equal(isKnownSystemPath('\\\\server\\profile\\AppData', {
    platform: 'win32', home: '\\\\server\\profile',
  }), false);
});

test('hidden inheritance begins at a dot-prefixed child, not the selected root or its ancestors', () => {
  const visibility = createPathVisibility('/home/sam/.outside/.chosen', { platform: 'linux', home: '/home/sam' });
  const root = visibility.classify('/home/sam/.outside/.chosen', '.chosen', null);
  assert.deepEqual(root, { hiddenPath: false, systemPath: false });
  assert.deepEqual(visibility.classify('/home/sam/.outside/.chosen/ordinary.txt', 'ordinary.txt', root), root);
  const secret = visibility.classify('/home/sam/.outside/.chosen/.secret', '.secret', root);
  assert.equal(secret.hiddenPath, true);
  assert.equal(visibility.classify('/home/sam/.outside/.chosen/.secret/ordinary.txt', 'ordinary.txt', secret).hiddenPath, true);
});

test('an explicitly selected system or app-data root exempts the scan from the system display filter only', () => {
  for (const [rootPath, context] of [
    ['/etc', { platform: 'linux', home: '/home/sam' }],
    ['/home/sam/.cache/app', { platform: 'linux', home: '/home/sam' }],
    ['/Users/sam/Library', { platform: 'darwin', home: '/Users/sam' }],
    ['C:\\Users\\sam\\AppData', { platform: 'win32', home: 'C:\\Users\\sam' }],
  ]) {
    const visibility = createPathVisibility(rootPath, context);
    assert.equal(visibility.rootIsSystem, true);
    const root = visibility.classify(rootPath, 'root', null);
    const ordinary = visibility.classify(`${rootPath}/ordinary`, 'ordinary', root);
    const dot = visibility.classify(`${rootPath}/.dot`, '.dot', ordinary);
    assert.deepEqual(ordinary, { hiddenPath: false, systemPath: false });
    assert.deepEqual(dot, { hiddenPath: true, systemPath: false });
  }
});

test('known system and hidden rules remain independent on descendants and context is captured', () => {
  const context = { platform: 'darwin', home: '/Users/sam' };
  const visibility = createPathVisibility('/Users/sam', context);
  context.home = '/Users/changed';
  const root = visibility.classify('/Users/sam', 'sam', null);
  const library = visibility.classify('/Users/sam/Library', 'Library', root);
  assert.deepEqual(library, { hiddenPath: false, systemPath: true });
  const hidden = visibility.classify('/Users/sam/Library/.hidden', '.hidden', library);
  assert.deepEqual(hidden, { hiddenPath: true, systemPath: true });
  assert.deepEqual(visibility.classify('/Users/sam/Library/.hidden/normal.txt', 'normal.txt', hidden), hidden);
});

test('invalid paths and unknown platforms do not imply native system attributes', () => {
  for (const value of [null, undefined, '', 'relative', '/usr\0junk']) {
    assert.equal(isKnownSystemPath(value, { platform: 'linux', home: '/home/sam' }), false);
  }
  assert.equal(isKnownSystemPath('/usr/file', { platform: 'freebsd', home: '/home/sam' }), false);
});
