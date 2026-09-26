'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCleanupService, protectedPathReason, snapshot, PLAN_TTL_MS } = require('../electron/cleanup.cjs');
const { createHistoryStore } = require('../electron/history.cjs');

async function fixture(t, names = ['first.txt', 'second.txt']) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'diskharbor-cleanup-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entries = new Map();
  const identities = new Map();
  for (let i = 0; i < names.length; i++) {
    const filePath = path.join(root, names[i]);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `Synthetic test file ${i}.`);
    const stat = await fs.lstat(filePath, { bigint: true });
    entries.set(i + 1, { id: i + 1, path: filePath, kind: 'file', state: 'ready', logicalSize: Number(stat.size), allocatedSize: Number(stat.blocks) * 512 });
    identities.set(i + 1, snapshot(stat, filePath, await fs.realpath(path.dirname(filePath))));
  }
  let context = { scanId: 'synthetic-fixture-scan', rootPath: root };
  let time = 100000;
  const calls = [];
  const records = [];
  const saveRecord = async (item) => {
    const index = records.findIndex((record) => record.id === item.id);
    const copy = structuredClone(item);
    if (index < 0) records.push(copy);
    else records[index] = copy;
  };
  const create = (extra = {}) => createCleanupService({
    getEntry: async (id) => entries.get(id),
    getIdentity: async (id) => identities.get(id),
    getScanContext: () => context,
    trashItem: async (filePath) => { calls.push(filePath); },
    historyStore: { upsert: saveRecord, append: saveRecord },
    now: () => time,
    measureSpace: async () => 10000,
    // Test only synthetic temporary files. Windows temp is inside AppData and
    // macOS temp is inside /private, both deliberately protected in production.
    // Exercise native filesystem identity with the Linux policy in this helper;
    // the separate policy test checks actual Windows/macOS protected paths.
    // This is dependency injection, never a production confirmation bypass.
    platform: 'linux',
    ...extra,
  });
  return { root, entries, identities, calls, records, create, setContext: (next) => { context = next; }, advance: (amount) => { time += amount; } };
}

test('only explicitly selected indexed files are planned; trash success is not reported as released bytes', async (t) => {
  const f = await fixture(t);
  const service = f.create();
  const plan = await service.plan([1, 1]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].eligible, true);
  const result = await service.execute(plan.id, async (review) => {
    assert.deepEqual(review.items.map((item) => item.path), [f.entries.get(1).path]);
    return true;
  });
  assert.deepEqual(f.calls, [f.entries.get(1).path]);
  assert.equal(result.success, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.freeSpaceDelta, 0);
  assert.equal(result.items[0].status, 'trashed');
  assert.equal(Object.hasOwn(result, 'releasedBytes'), false);
  assert.equal(f.records.length, 1);
  assert.equal(await fs.readFile(f.entries.get(2).path, 'utf8'), 'Synthetic test file 1.');
});

test('a file replaced by a symlink after preview is refused without touching its target', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  const service = f.create();
  const plan = await service.plan([1]);
  await fs.unlink(f.entries.get(1).path);
  await fs.symlink(f.entries.get(2).path, f.entries.get(1).path);
  const result = await service.execute(plan.id, async () => true);
  assert.equal(result.success, 0);
  assert.equal(result.items[0].error, 'SYMLINK');
  assert.deepEqual(f.calls, []);
  assert.equal(await fs.readFile(f.entries.get(2).path, 'utf8'), 'Synthetic test file 1.');
});

test('content or identity changes made while native confirmation is open are rechecked', async (t) => {
  const f = await fixture(t);
  const service = f.create();
  const plan = await service.plan([1]);
  const result = await service.execute(plan.id, async () => {
    await fs.writeFile(f.entries.get(1).path, 'A different, much longer file written while the confirmation is open.');
    return true;
  });
  assert.equal(result.items[0].error, 'IDENTITY_CHANGED');
  assert.deepEqual(f.calls, []);
});

test('replacing the parent directory with a symlink invalidates a plan', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t, ['selected/item.txt', 'other/item.txt']);
  const service = f.create();
  const plan = await service.plan([1]);
  await fs.rename(path.join(f.root, 'selected'), path.join(f.root, 'old-selected'));
  await fs.symlink(path.join(f.root, 'other'), path.join(f.root, 'selected'), 'dir');
  const result = await service.execute(plan.id, async () => true);
  assert.equal(result.items[0].error, 'PARENT_CHANGED');
  assert.deepEqual(f.calls, []);
  assert.equal(await fs.readFile(f.entries.get(2).path, 'utf8'), 'Synthetic test file 1.');
});

test('hidden configuration, system paths, and unsupported Windows namespaces are protected', () => {
  const linux = { platform: 'linux', home: '/home/synthetic' };
  assert.equal(protectedPathReason('/home/synthetic/.config/app/settings.json', linux), 'HIDDEN_PATH');
  assert.equal(protectedPathReason('/etc/config.txt', linux), 'SYSTEM_PATH');
  assert.equal(protectedPathReason('/var/log/app.log', linux), 'SYSTEM_PATH');
  assert.equal(protectedPathReason('/home/synthetic/Documents/etc-not-system.txt', linux), null);
  assert.equal(protectedPathReason('/run/media/synthetic/USB/picture.png', linux), null);
  assert.equal(protectedPathReason('C:\\Windows\\file.txt', { platform: 'win32' }), 'SYSTEM_PATH');
  assert.equal(protectedPathReason('C:\\Users\\Synthetic\\AppData\\app.txt', { platform: 'win32' }), 'APPLICATION_DATA');
  assert.equal(protectedPathReason('\\\\server\\share\\file.txt', { platform: 'win32' }), 'UNSUPPORTED_VOLUME');
  assert.equal(protectedPathReason('/Users/synthetic/Library/app/file.txt', { platform: 'darwin', home: '/Users/synthetic' }), 'APPLICATION_DATA');
});

test('dotfiles, incomplete directories, hardlinks, unsupported names, and unknown IDs are not executable candidates', async (t) => {
  const f = await fixture(t, ['.config/settings.json', 'ordinary.txt', 'another.txt']);
  const dir = path.join(f.root, 'directory');
  await fs.mkdir(dir);
  f.entries.set(4, { id: 4, path: dir, kind: 'directory', logicalSize: 0, allocatedSize: 0 });
  f.identities.set(4, { path: dir });
  f.identities.set(3, { ...f.identities.get(3), unsupportedPath: true });
  await fs.link(f.entries.get(2).path, path.join(f.root, 'hardlink.txt'));
  const service = f.create();
  const plan = await service.plan([1, 2, 3, 4, 999]);
  assert.deepEqual(plan.items.map((item) => item.reason), ['HIDDEN_PATH', 'SHARED_FILE', 'UNSUPPORTED_PATH', 'SCAN_INCOMPLETE', 'NOT_IN_SCAN']);
  await assert.rejects(service.execute(plan.id, async () => true), /NO_ELIGIBLE_FILES/);
  assert.deepEqual(f.calls, []);
});

test('skipped and incomplete scan entries are not actionable even when their metadata exists', async (t) => {
  const f = await fixture(t);
  f.entries.get(1).state = 'skipped';
  f.entries.get(2).state = 'error';
  const plan = await f.create().plan([1, 2]);
  assert.deepEqual(plan.items.map((item) => item.reason), ['SCAN_INCOMPLETE', 'SCAN_INCOMPLETE']);
  assert.deepEqual(f.calls, []);
});

test('partial native trash failure is retained and never falls back to permanent deletion', async (t) => {
  const f = await fixture(t);
  const service = f.create({ trashItem: async (filePath) => {
    f.calls.push(filePath);
    if (filePath === f.entries.get(2).path) throw Object.assign(new Error('Synthetic denied trash'), { code: 'EACCES' });
  } });
  const plan = await service.plan([1, 2]);
  const result = await service.execute(plan.id, async () => true);
  assert.equal(result.success, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.items[1].status, 'failed');
  assert.equal(result.items[1].error, 'EACCES');
  assert.equal(await fs.readFile(f.entries.get(2).path, 'utf8'), 'Synthetic test file 1.');
});

test('cancelling native confirmation makes no trash calls and consumes the plan', async (t) => {
  const f = await fixture(t);
  const service = f.create();
  const plan = await service.plan([1]);
  const result = await service.execute(plan.id, async () => false);
  assert.equal(result.items[0].status, 'cancelled');
  assert.equal(result.freeSpaceDelta, null);
  assert.deepEqual(f.calls, []);
  await assert.rejects(service.execute(plan.id, async () => true), /PLAN_USED_OR_MISSING/);
});

test('a plan is consumed before confirmation so concurrent reuse cannot execute twice', async (t) => {
  const f = await fixture(t);
  const service = f.create();
  const plan = await service.plan([1]);
  let resolveConfirmation;
  const execution = service.execute(plan.id, () => new Promise((resolve) => { resolveConfirmation = resolve; }));
  await assert.rejects(service.execute(plan.id, async () => true), /PLAN_USED_OR_MISSING/);
  resolveConfirmation(true);
  await execution;
  assert.equal(f.calls.length, 1);
});

test('expired plans and changed scan sessions cannot execute', async (t) => {
  const f = await fixture(t);
  const service = f.create();
  const expired = await service.plan([1]);
  f.advance(PLAN_TTL_MS + 1);
  await assert.rejects(service.execute(expired.id, async () => true), /PLAN_EXPIRED/);
  const changed = await service.plan([1]);
  f.setContext({ scanId: 'another-scan', rootPath: f.root });
  await assert.rejects(service.execute(changed.id, async () => true), /SCAN_CHANGED/);
  assert.deepEqual(f.calls, []);
});

test('initial journal failure blocks native trash and preserves the selected original', async (t) => {
  const f = await fixture(t);
  const failWrite = async () => { throw new Error('Synthetic write failure'); };
  const service = f.create({ historyStore: { upsert: failWrite, append: failWrite } });
  const plan = await service.plan([1]);
  await assert.rejects(service.execute(plan.id, async () => true), /HISTORY_WRITE_FAILED/);
  assert.deepEqual(f.calls, []);
  assert.equal(await fs.readFile(f.entries.get(1).path, 'utf8'), 'Synthetic test file 0.');
});

test('measured space delta may be negative and is not labelled released space', async (t) => {
  const f = await fixture(t);
  const measurements = [1000, 900];
  const service = f.create({ measureSpace: async () => measurements.shift() });
  const plan = await service.plan([1]);
  const result = await service.execute(plan.id, async () => true);
  assert.equal(result.success, 1);
  assert.equal(result.freeSpaceDelta, -100);
  assert.equal(Object.hasOwn(result, 'releasedBytes'), false);
});

test('history writes are serialized and atomic, retain 50 records, and clear only the record file', async (t) => {
  const f = await fixture(t);
  const historyPath = path.join(f.root, 'local-data', 'operation-history.json');
  const store = createHistoryStore(historyPath);
  await Promise.all(Array.from({ length: 60 }, (_, i) => store.append({ id: `synthetic-${i}`, time: i, rootPath: f.root, success: 0, failed: 0, items: [], freeSpaceDelta: null })));
  const fromDisk = await createHistoryStore(historyPath).list();
  assert.equal(fromDisk.length, 50);
  assert.equal(fromDisk[0].id, 'synthetic-59');
  assert.equal(fromDisk.at(-1).id, 'synthetic-10');
  assert.deepEqual(await fs.readdir(path.dirname(historyPath)), ['operation-history.json']);
  await store.clear();
  assert.deepEqual(JSON.parse(await fs.readFile(historyPath, 'utf8')), []);
  assert.equal(await fs.readFile(f.entries.get(1).path, 'utf8'), 'Synthetic test file 0.');
});
