'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { createCleanupService, protectedPathReason } = require('../electron/cleanup.cjs');
const { ScanIndex } = require('../electron/scanner.cjs');
const native = require('../electron/native-metadata.cjs');

const windowsOnly = { skip: process.platform !== 'win32' };

test('hidden cleanup options are strict, non-persistent and do not bypass protected path rules', async () => {
  const service = createCleanupService({ trashItem: async () => {}, getScanContext: () => null });
  for (const options of [null, true, [], { allowHidden: 1 }, { allowHidden: 'true' }, { allowHidden: true, allowSystem: true }]) {
    await assert.rejects(service.plan([1], options), /INVALID_CLEANUP_OPTIONS/);
  }
  const policy = { platform: 'win32', home: 'C:\\Users\\synthetic', allowHidden: true };
  for (const [target, reason] of [
    ['D:\\chosen\\.config\\settings.json', 'HIDDEN_PATH'],
    ['D:\\Windows\\file.txt', 'SYSTEM_PATH'],
    ['C:\\Users\\synthetic\\AppData\\file.txt', 'APPLICATION_DATA'],
    ['C:\\Users\\synthetic\\OneDrive\\file.txt', 'CLOUD_LOCATION_PROTECTED'],
  ]) assert.equal(protectedPathReason(target, policy), reason);
});

// Only owned ordinary paths outside Windows AppData are used. Native metadata
// and Windows attributes are real; the Trash adapter records calls and never changes files.
async function ownedWindowsFixture(t, files) {
  const root = path.join(process.cwd(), 'output', `cleanup-hidden-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  const created = new Set([root]);
  const attrib = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'attrib.exe');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const flag = async (relative, attribute, enabled = true) => {
    const target = path.join(root, relative);
    assert.ok(target.startsWith(root + path.sep));
    assert.ok(['H', 'S'].includes(attribute));
    const before = native.getNativePathFlags(target);
    // attrib +S on an already hidden file can print a warning yet exit zero.
    // Change exactly one bit through .NET, preserving all other attributes,
    // then verify both H/S bits through the real native metadata API.
    const script = `$ErrorActionPreference='Stop'; $target=$env:DISKHARBOR_OWNED_ATTRIBUTE_PATH;
      $before=[int][IO.File]::GetAttributes($target); $mask=${attribute === 'H' ? 2 : 4};
      $next=${enabled ? '$before -bor $mask' : '$before -band (-bnot $mask)'};
      [IO.File]::SetAttributes($target,[IO.FileAttributes]$next);
      if ([int][IO.File]::GetAttributes($target) -ne $next) { throw 'Owned fixture attributes were not applied' }`;
    await execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      shell: false, windowsHide: true, timeout: 10000, maxBuffer: 8192,
      env: { ...process.env, DISKHARBOR_OWNED_ATTRIBUTE_PATH: target },
    });
    const after = native.getNativePathFlags(target);
    assert.equal(after.hidden, attribute === 'H' ? enabled : before.hidden, 'Fixture hidden bit must match the requested state.');
    assert.equal(after.system, attribute === 'S' ? enabled : before.system, 'Fixture system bit must match the requested state.');
  };
  t.after(async () => {
    native.closeNativeSession();
    for (const target of [...created].reverse()) await execFile(attrib, ['-H', '-S', '-O', target], { shell: false, windowsHide: true, timeout: 10000 }).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    assert.ok(target.startsWith(root + path.sep));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
    for (let directory = path.dirname(target); directory !== root; directory = path.dirname(directory)) created.add(directory);
    created.add(target);
  }
  native.ensureNativePolicy();
  const calls = [];
  const records = [];
  async function scannedService() {
    const index = new ScanIndex(root);
    const summary = await index.scan();
    assert.equal(summary.state, 'completed');
    assert.equal(summary.errors, 0);
    const service = createCleanupService({
      getEntry: id => index.entry(id), getIdentity: id => index.entryIdentity(id),
      getManifest: id => index.cleanupManifest(id),
      getScanContext: () => ({ scanId: summary.scanId, rootPath: root, rootId: summary.rootId }),
      trashItem: async target => { calls.push(target); },
      historyStore: { upsert: async item => { records.push(structuredClone(item)); } },
      measureSpace: async () => ({ sample: { measuredAt: 1, total: 100, free: 50 }, signature: 'owned-fixture' }),
      home: path.join(root, 'unselected-home'),
    });
    const entry = relative => {
      const found = index.query({ search: path.join(root, relative), limit: 100 }).entries.find(item => item.path === path.join(root, relative));
      assert.ok(found, `Owned file must be indexed: ${relative}`);
      return found;
    };
    return { service, entry };
  }
  return { root, flag, calls, records, scannedService };
}

test('real Windows hidden files require a fresh explicit plan; options and returned plans cannot alter other plans', windowsOnly, async t => {
  const f = await ownedWindowsFixture(t, { 'hidden.txt': 'owned hidden bytes' });
  await f.flag('hidden.txt', 'H');
  const { service, entry } = await f.scannedService();
  const id = entry('hidden.txt').id;
  const blocked = await service.plan([id]);
  assert.equal(blocked.allowHidden, false);
  assert.equal(blocked.hiddenReviewAvailable, true);
  assert.equal(blocked.items[0].reason, 'HIDDEN_PATH');
  const options = { allowHidden: true };
  const allowed = await service.plan([id], options);
  assert.equal(allowed.allowHidden, true);
  assert.equal(allowed.hiddenReviewAvailable, true);
  assert.equal(allowed.items[0].eligible, true);
  options.allowHidden = false;
  allowed.allowHidden = false;
  blocked.allowHidden = true;
  blocked.items[0].eligible = true;
  await assert.rejects(service.execute(blocked.id, async () => assert.fail('Blocked plan must not reach confirmation.')), /NO_ELIGIBLE_FILES/);
  const result = await service.execute(allowed.id, async review => {
    assert.equal(review.allowHidden, true, 'Stored plan options are detached from caller objects.');
    return true;
  });
  assert.equal(result.success, 1);
  assert.deepEqual(f.calls, [path.join(f.root, 'hidden.txt')]);
  const next = await service.plan([id]);
  assert.equal(next.allowHidden, false);
  assert.equal(next.items[0].reason, 'HIDDEN_PATH');
  assert.equal(await fs.readFile(path.join(f.root, 'hidden.txt'), 'utf8'), 'owned hidden bytes');
});

test('real Windows H plus S stays blocked and does not offer hidden-only review', windowsOnly, async t => {
  const f = await ownedWindowsFixture(t, { 'system.txt': 'owned protected bytes' });
  await f.flag('system.txt', 'H');
  await f.flag('system.txt', 'S');
  const { service, entry } = await f.scannedService();
  for (const options of [{}, { allowHidden: true }]) {
    const plan = await service.plan([entry('system.txt').id], options);
    assert.equal(plan.items[0].reason, 'SYSTEM_PATH');
    assert.equal(plan.hiddenReviewAvailable, false);
    await assert.rejects(service.execute(plan.id, async () => assert.fail('System file cannot reach confirmation.')), /NO_ELIGIBLE_FILES/);
  }
  assert.deepEqual(f.calls, []);
});

test('real Windows directory hidden descendants are reviewed explicitly and remain one whole-directory operation', windowsOnly, async t => {
  const f = await ownedWindowsFixture(t, { 'folder/hidden.txt': 'owned hidden child', 'folder/ordinary.txt': 'owned visible child' });
  await f.flag(path.join('folder', 'hidden.txt'), 'H');
  const { service, entry } = await f.scannedService();
  const folder = entry('folder');
  const blocked = await service.plan([folder.id]);
  assert.equal(blocked.items[0].reason, 'HIDDEN_PATH');
  assert.equal(blocked.items[0].blockedPath, path.join(f.root, 'folder', 'hidden.txt'));
  assert.equal(blocked.hiddenReviewAvailable, true);
  const allowed = await service.plan([folder.id], { allowHidden: true });
  assert.equal(allowed.items[0].eligible, true);
  assert.equal(allowed.hiddenReviewAvailable, true);
  const result = await service.execute(allowed.id, async () => true);
  assert.equal(result.success, 1);
  assert.deepEqual(f.calls, [path.join(f.root, 'folder')]);
  assert.equal(await fs.readFile(path.join(f.root, 'folder', 'hidden.txt'), 'utf8'), 'owned hidden child');
  await f.flag('folder', 'H');
  const again = await f.scannedService();
  const hiddenFolder = again.entry('folder');
  const hiddenDefault = await again.service.plan([hiddenFolder.id]);
  assert.equal(hiddenDefault.items[0].reason, 'HIDDEN_PATH');
  assert.equal(hiddenDefault.items[0].blockedPath, hiddenFolder.path);
  assert.equal(hiddenDefault.hiddenReviewAvailable, true);
  const hiddenAllowed = await again.service.plan([hiddenFolder.id], { allowHidden: true });
  assert.equal(hiddenAllowed.items[0].eligible, true);
  assert.equal((await again.service.execute(hiddenAllowed.id, async () => true)).success, 1);
  assert.deepEqual(f.calls, [folder.path, hiddenFolder.path]);
});

test('real Windows attribute changes during confirmation are checked using each plan permission', windowsOnly, async t => {
  const f = await ownedWindowsFixture(t, { 'ordinary.txt': 'owned ordinary bytes', 'hidden.txt': 'owned hidden bytes', 'folder/child.txt': 'owned child bytes' });
  await f.flag('hidden.txt', 'H');
  await f.flag(path.join('folder', 'child.txt'), 'H');
  const { service, entry } = await f.scannedService();
  const normalPlan = await service.plan([entry('ordinary.txt').id]);
  const allowPlan = await service.plan([entry('hidden.txt').id], { allowHidden: true });
  const directoryPlan = await service.plan([entry('folder').id], { allowHidden: true });
  const normal = await service.execute(normalPlan.id, async () => { await f.flag('ordinary.txt', 'H'); return true; });
  assert.equal(normal.items[0].error, 'HIDDEN_PATH', 'Another allow-hidden plan must not relax this plan.');
  const changed = await service.execute(allowPlan.id, async () => { await f.flag('hidden.txt', 'S'); return true; });
  assert.equal(changed.items[0].error, 'SYSTEM_PATH');
  const directory = await service.execute(directoryPlan.id, async () => { await f.flag(path.join('folder', 'child.txt'), 'S'); return true; });
  assert.equal(directory.success, 0);
  assert.equal(directory.items[0].error, 'SYSTEM_PATH');
  assert.deepEqual(f.calls, []);
});
