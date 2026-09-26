'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ScanIndex } = require('../electron/scanner.cjs');
const { createCleanupService, PLAN_TTL_MS } = require('../electron/cleanup.cjs');

async function fixture(t, files = { 'chosen/first.txt': 'first', 'chosen/deep/second.txt': 'second', 'outside.txt': 'outside' }, beforeScan) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'diskharbor-directory-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'scan');
  const trash = path.join(base, 'trash');
  await fs.mkdir(root);
  await fs.mkdir(trash);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    if (content === null) await fs.mkdir(target, { recursive: true });
    else { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content); }
  }
  if (beforeScan) await beforeScan(root, base);
  const index = new ScanIndex(root);
  await index.scan();
  let context = { scanId: index.scanId, rootPath: root, rootId: 1 };
  let time = 100000;
  const calls = [];
  const journals = new Map();
  const writes = [];
  const nativeTrash = async filePath => {
    calls.push(filePath);
    const latest = [...journals.values()].at(-1);
    assert.equal(latest?.items.find(item => item.path === filePath)?.status, 'processing', 'native mutation requires a durable processing marker');
    await fs.rename(filePath, path.join(trash, `${calls.length}-${path.basename(filePath)}`));
  };
  const write = async record => { const copy = structuredClone(record); writes.push(copy); journals.set(copy.id, copy); };
  const create = overrides => createCleanupService({
    getEntry: id => index.entry(id), getIdentity: id => index.entryIdentity(id), getManifest: id => index.cleanupManifest(id),
    getScanContext: () => context, trashItem: nativeTrash, historyStore: { upsert: write },
    // Fixtures are synthetic. Native policy exclusions are covered separately;
    // Windows/macOS temporary paths are protected production locations.
    platform: 'linux', home: path.join(base, 'home'), now: () => time,
    measureSpace: async () => ({ sample: { measuredAt: time, total: 20000, free: 10000 }, signature: 'fixture-volume' }),
    ...overrides,
  });
  const entry = relative => relative === '' ? index.entry(1) : index.query({ limit: 10000 }).entries.find(item => item.path === path.join(root, relative));
  return { base, root, trash, index, entry, create, calls, journals, writes, write, nativeTrash, advance: delta => { time += delta; }, invalidate: () => { context = null; } };
}

test('a verified directory is one native operation with all descendants preserved in Trash', async t => {
  const f = await fixture(t);
  const directory = f.entry('chosen');
  const service = f.create();
  const plan = await service.plan([directory.id]);
  assert.equal(plan.items[0].eligible, true);
  assert.equal(plan.items[0].kind, 'directory');
  assert.equal(plan.items[0].fileCount, 2);
  assert.equal(plan.totalBytes, directory.allocatedSize ?? directory.logicalSize);
  assert.equal(plan.expiresAt - plan.createdAt, PLAN_TTL_MS);
  const progress = [];
  const result = await service.execute(plan.id, async () => true, { onProgress: event => progress.push(event) });
  assert.deepEqual(f.calls, [directory.path]);
  assert.equal(result.state, 'completed');
  assert.equal(result.items[0].status, 'trashed');
  assert.equal(result.total, 1);
  assert.equal(result.totalBytes, plan.totalBytes);
  assert.equal(await fs.readFile(path.join(f.trash, '1-chosen/deep/second.txt'), 'utf8'), 'second');
  await assert.rejects(fs.lstat(directory.path), { code: 'ENOENT' });
  assert.equal(f.writes[0].items[0].status, 'pending');
  assert.equal(f.writes[1].items[0].status, 'processing');
  assert.equal(f.journals.get(result.id).state, 'completed');
  assert.equal(progress[0].state, 'confirming');
  assert.equal(progress.at(-1).processed, progress.at(-1).total);
  assert.ok(progress.every(event => event.id === result.id && event.planId === plan.id));
});

test('selected descendants are omitted regardless of selection order and directories are not recursively trashed twice', async t => {
  const f = await fixture(t);
  const service = f.create();
  const directory = f.entry('chosen');
  const plan = await service.plan([f.entry('chosen/deep/second.txt').id, f.entry('chosen/deep').id, directory.id, directory.id]);
  assert.equal(plan.omittedCount, 2);
  assert.deepEqual(plan.items.map(item => item.id), [directory.id]);
  assert.equal(plan.totalBytes, directory.allocatedSize ?? directory.logicalSize);
  // A caller cannot change the internally retained authorization by mutating its plan copy.
  plan.items[0].path = f.entry('outside.txt').path;
  await service.execute(plan.id, async () => true);
  assert.deepEqual(f.calls, [directory.path]);
  assert.equal(await fs.readFile(f.entry('outside.txt').path, 'utf8'), 'outside');
});

test('a blocked selected ancestor never falls back to its otherwise ordinary selected child', async t => {
  const f = await fixture(t, { 'chosen/.config/settings.json': '{}', 'chosen/ordinary.txt': 'keep' });
  const service = f.create();
  const plan = await service.plan([f.entry('chosen/ordinary.txt').id, f.entry('chosen').id]);
  assert.equal(plan.omittedCount, 1);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].eligible, false);
  assert.equal(plan.items[0].reason, 'UNSAFE_DESCENDANT');
  assert.ok(plan.items[0].blockedPath.includes('.config'));
  await assert.rejects(service.execute(plan.id, async () => true), /NO_ELIGIBLE_FILES/);
  assert.deepEqual(f.calls, []);
});

for (const [name, mutate] of [
  ['added descendant', f => fs.writeFile(path.join(f.root, 'chosen/deep/new.txt'), 'new')],
  ['deleted descendant', f => fs.unlink(path.join(f.root, 'chosen/deep/second.txt'))],
  ['changed descendant contents', f => fs.writeFile(path.join(f.root, 'chosen/deep/second.txt'), 'different and longer')],
  ['renamed directory', f => fs.rename(path.join(f.root, 'chosen'), path.join(f.root, 'renamed'))],
]) {
  test(`${name} after preview refuses the whole directory without touching another file`, async t => {
    const f = await fixture(t);
    const service = f.create();
    const plan = await service.plan([f.entry('chosen').id]);
    assert.equal(plan.items[0].eligible, true);
    const result = await service.execute(plan.id, async () => { await mutate(f); return true; });
    assert.equal(result.success, 0);
    assert.equal(result.items[0].error, 'DIRECTORY_CHANGED');
    assert.deepEqual(f.calls, []);
    assert.equal(await fs.readFile(path.join(f.root, 'outside.txt'), 'utf8'), 'outside');
  });
}

test('metadata-only changes to a descendant invalidate a directory plan', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const service = f.create();
  const plan = await service.plan([f.entry('chosen').id]);
  const result = await service.execute(plan.id, async () => {
    await fs.chmod(path.join(f.root, 'chosen/deep/second.txt'), 0o400);
    return true;
  });
  assert.equal(result.items[0].error, 'DIRECTORY_CHANGED');
  assert.deepEqual(f.calls, []);
});

test('an omitted member in an otherwise ready scan manifest is detected on the filesystem', async t => {
  const f = await fixture(t);
  const service = f.create({ getManifest: id => {
    const manifest = f.index.cleanupManifest(id);
    manifest.entries = manifest.entries.filter(node => node.entry.name !== 'first.txt');
    return manifest;
  } });
  const plan = await service.plan([f.entry('chosen').id]);
  assert.equal(plan.items[0].eligible, false);
  assert.equal(plan.items[0].reason, 'DIRECTORY_CHANGED');
  assert.deepEqual(f.calls, []);
});

test('nested symlinks are refused at planning and replacements are refused before execution', { skip: process.platform === 'win32' }, async t => {
  const linked = await fixture(t, undefined, root => fs.symlink(path.join(root, 'outside.txt'), path.join(root, 'chosen/link')));
  const blocked = await linked.create().plan([linked.entry('chosen').id]);
  assert.equal(blocked.items[0].reason, 'UNSAFE_DESCENDANT');
  assert.ok(blocked.items[0].blockedPath.endsWith('link'));

  const f = await fixture(t);
  const service = f.create();
  const plan = await service.plan([f.entry('chosen').id]);
  const result = await service.execute(plan.id, async () => {
    const target = path.join(f.root, 'chosen/deep/second.txt');
    await fs.unlink(target);
    await fs.symlink(path.join(f.root, 'outside.txt'), target);
    return true;
  });
  assert.equal(result.success, 0);
  assert.ok(['DIRECTORY_CHANGED', 'UNSAFE_DESCENDANT'].includes(result.items[0].error));
  assert.deepEqual(f.calls, []);
  assert.equal(await fs.readFile(path.join(f.root, 'outside.txt'), 'utf8'), 'outside');
});

test('hard-linked descendants cannot be hidden inside a selected directory', async t => {
  const f = await fixture(t, undefined, (root, base) => fs.link(path.join(root, 'chosen/first.txt'), path.join(base, 'external-hardlink.txt')));
  const plan = await f.create().plan([f.entry('chosen').id]);
  assert.equal(plan.items[0].eligible, false);
  assert.equal(plan.items[0].reason, 'UNSAFE_DESCENDANT');
  assert.ok(plan.items[0].blockedPath.endsWith('first.txt'));
});

test('scan roots, home directories, incomplete and oversized manifests are refused', async t => {
  const f = await fixture(t);
  assert.equal((await f.create().plan([1])).items[0].reason, 'PROTECTED_ROOT');
  const directory = f.entry('chosen');
  assert.equal((await f.create({ home: directory.path }).plan([directory.id])).items[0].reason, 'PROTECTED_ROOT');
  assert.equal((await f.create({ getManifest: undefined }).plan([directory.id])).items[0].reason, 'MANIFEST_UNAVAILABLE');
  assert.equal((await f.create({ getManifest: () => ({ entries: [], truncated: false }) }).plan([directory.id])).items[0].reason, 'MANIFEST_INCOMPLETE');
  assert.equal((await f.create({ getManifest: () => ({ entries: [], truncated: true }) }).plan([directory.id])).items[0].reason, 'DIRECTORY_TOO_LARGE');
  const unknown = await f.create({ getManifest: id => {
    const manifest = f.index.cleanupManifest(id);
    manifest.entries.find(node => node.entry.kind === 'file').identity.unsupportedPath = true;
    return manifest;
  } }).plan([directory.id]);
  assert.equal(unknown.items[0].reason, 'UNSAFE_DESCENDANT');
  const skipped = await f.create({ getManifest: id => {
    const manifest = f.index.cleanupManifest(id);
    manifest.entries.find(node => node.entry.kind === 'file').entry.state = 'skipped';
    return manifest;
  } }).plan([directory.id]);
  assert.equal(skipped.items[0].reason, 'MANIFEST_INCOMPLETE');
  assert.deepEqual(f.calls, []);
});

test('cancel during an in-flight native call lets that call finish and cancels all unstarted items', async t => {
  const f = await fixture(t, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
  let cancel = false;
  let entered;
  let release;
  const callStarted = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const events = [];
  const service = f.create({ trashItem: async filePath => { entered(); await gate; await f.nativeTrash(filePath); } });
  const plan = await service.plan(['a.txt', 'b.txt', 'c.txt'].map(relative => f.entry(relative).id));
  const execution = service.execute(plan.id, async () => true, { shouldCancel: () => cancel, onProgress: event => events.push(event) });
  await callStarted;
  cancel = true;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok(events.some(event => event.state === 'cancelling' && event.currentPath === f.entry('a.txt').path));
  assert.deepEqual(f.calls, []);
  release();
  const result = await execution;
  assert.equal(result.state, 'cancelled');
  assert.deepEqual(result.items.map(item => item.status), ['trashed', 'cancelled', 'cancelled']);
  assert.equal(f.calls.length, 1);
  assert.equal(await fs.readFile(f.entry('b.txt').path, 'utf8'), 'b');
  assert.equal(await fs.readFile(f.entry('c.txt').path, 'utf8'), 'c');
  assert.equal(events.at(-1).processed, 3);
  assert.equal(events.at(-1).cancelled, 2);
});

test('TTL applies to confirmation acceptance but does not expire an accepted long-running batch', async t => {
  const f = await fixture(t, { 'a.txt': 'a', 'b.txt': 'b' });
  const service = f.create({ trashItem: async filePath => { await f.nativeTrash(filePath); f.advance(PLAN_TTL_MS + 1); } });
  const plan = await service.plan([f.entry('a.txt').id, f.entry('b.txt').id]);
  const result = await service.execute(plan.id, async () => true);
  assert.equal(result.success, 2);
  assert.equal(result.state, 'completed');
  const delayed = await fixture(t, { 'a.txt': 'a' });
  const expiredService = delayed.create();
  const expired = await expiredService.plan([delayed.entry('a.txt').id]);
  await assert.rejects(expiredService.execute(expired.id, async () => { delayed.advance(PLAN_TTL_MS + 1); return true; }), /PLAN_EXPIRED/);
  assert.deepEqual(delayed.calls, []);
});

test('initial journal failure refuses every mutation and reports a failed progress state', async t => {
  const f = await fixture(t);
  const events = [];
  const service = f.create({ historyStore: { upsert: async () => { throw new Error('Disk full'); } } });
  const plan = await service.plan([f.entry('chosen').id]);
  await assert.rejects(service.execute(plan.id, async () => true, { onProgress: event => events.push(event) }), /HISTORY_WRITE_FAILED/);
  assert.deepEqual(f.calls, []);
  assert.equal(events.at(-1).state, 'failed');
  assert.equal(await fs.readFile(path.join(f.root, 'chosen/first.txt'), 'utf8'), 'first');
});

test('a processing journal failure stops before native mutation even if the final journal can recover', async t => {
  const f = await fixture(t, { 'a.txt': 'a', 'b.txt': 'b' });
  let writes = 0;
  const service = f.create({ historyStore: { upsert: async record => {
    if (++writes === 2) throw new Error('Processing journal failed');
    await f.write(record);
  } } });
  const plan = await service.plan([f.entry('a.txt').id, f.entry('b.txt').id]);
  const result = await service.execute(plan.id, async () => true);
  assert.equal(result.state, 'interrupted');
  assert.equal(result.historyError, 'HISTORY_WRITE_FAILED');
  assert.deepEqual(result.items.map(item => item.status), ['skipped', 'skipped']);
  assert.deepEqual(f.calls, []);
  assert.equal(f.journals.get(result.id).state, 'interrupted');
});

test('journal failure after a native result preserves known outcomes and leaves durable uncertainty for recovery', async t => {
  const f = await fixture(t, { 'a.txt': 'a', 'b.txt': 'b' });
  let writes = 0;
  const service = f.create({ historyStore: { upsert: async record => {
    if (++writes >= 3) throw new Error('Storage no longer writable');
    await f.write(record);
  } } });
  const plan = await service.plan([f.entry('a.txt').id, f.entry('b.txt').id]);
  const result = await service.execute(plan.id, async () => true);
  assert.equal(result.state, 'interrupted');
  assert.equal(result.success, 1);
  assert.equal(result.historyError, 'HISTORY_WRITE_FAILED');
  assert.deepEqual(result.items.map(item => item.status), ['trashed', 'skipped']);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.journals.get(result.id).items.map(item => item.status), ['processing', 'pending']);
  assert.equal(await fs.readFile(f.entry('b.txt').path, 'utf8'), 'b');
});

test('scan context invalidation during final filesystem validation prevents the native call', async t => {
  const f = await fixture(t, { 'a.txt': 'a' });
  const service = f.create();
  const selected = f.entry('a.txt');
  const plan = await service.plan([selected.id]);
  const original = fs.lstat;
  t.mock.method(fs, 'lstat', async (filePath, options) => {
    const stat = await original(filePath, options);
    if (String(filePath) === selected.path) f.invalidate();
    return stat;
  });
  const result = await service.execute(plan.id, async () => true);
  assert.equal(result.state, 'interrupted');
  assert.equal(result.items[0].error, 'SCAN_CHANGED');
  assert.deepEqual(f.calls, []);
});
