'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ScanIndex } = require('../electron/scanner.cjs');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'diskharbor-space-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'kept.txt'), 'metadata only');
  return root;
}

function volume(free = 40n, overrides = {}) {
  return { type: 0xef53n, bsize: 1024n, blocks: 100n, bavail: free, ...overrides };
}

function mockVolume(t, read) {
  t.mock.method(fs, 'statfs', async (file, options) => {
    assert.deepEqual(options, { bigint: true });
    return read(String(file));
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const [name, free, delta] of [['positive', 50n, 10240], ['negative', 25n, -15360], ['zero', 40n, 0], ['full volume', 0n, -40960]]) {
  test(`${name} space change compares the same timestamped scan baseline without changing scan data`, async t => {
    const root = await fixture(t);
    let next = volume();
    mockVolume(t, () => next);
    const scanner = new ScanIndex(root, { scanId: `space-${name}` });
    const started = Date.now();
    const summary = await scanner.scan();
    const entries = scanner.query({ limit: 100 });
    const identities = entries.entries.map(entry => scanner.entryIdentity(entry.id));
    const file = await fs.lstat(path.join(root, 'kept.txt'), { bigint: true });
    next = volume(free);
    // Measurement must only use metadata, never reread contents or enumerate the tree.
    t.mock.method(fs, 'readFile', async () => { throw new Error('Content read is forbidden.'); });
    t.mock.method(fs, 'opendir', async () => { throw new Error('Enumeration is forbidden.'); });
    const result = await scanner.measureSpace();
    assert.equal(result.scanId, `space-${name}`);
    assert.equal(result.rootPath, root);
    assert.equal(result.comparison, 'comparable');
    assert.equal(result.delta, delta);
    assert.deepEqual(summary.volume, { total: 102400, free: 40960 });
    assert.ok(result.baseline.measuredAt >= started);
    assert.ok(result.current.measuredAt >= result.baseline.measuredAt);
    assert.ok(result.current.measuredAt <= Date.now());
    assert.equal(result.current.free, Number(free) * 1024);
    result.baseline.free = 999;
    result.current.free = 999;
    assert.equal((await scanner.measureSpace()).baseline.free, 40960);
    assert.deepEqual(scanner.summary(), summary);
    assert.deepEqual(scanner.query({ limit: 100 }), entries);
    assert.deepEqual(entries.entries.map(entry => scanner.entryIdentity(entry.id)), identities);
    const unchanged = await fs.lstat(path.join(root, 'kept.txt'), { bigint: true });
    assert.equal(unchanged.ino, file.ino);
    assert.equal(unchanged.mtimeNs, file.mtimeNs);
    assert.equal(unchanged.size, file.size);
  });
}

test('an unavailable initial sample remains unknown even after a valid manual sample', async t => {
  const root = await fixture(t);
  let unavailable = true;
  mockVolume(t, () => { if (unavailable) throw new Error('Fixture statfs failure.'); return volume(50n); });
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.equal(summary.state, 'completed');
  assert.equal(summary.volume, null);
  unavailable = false;
  const result = await scanner.measureSpace();
  assert.equal(result.baseline, null);
  assert.equal(result.delta, null);
  assert.equal(result.comparison, 'baseline-unavailable');
  assert.equal(result.current.free, 51200);
  assert.equal(scanner.summary().volume, null);
});

test('a root identity mismatch around the initial capacity read discards that baseline', async t => {
  const root = await fixture(t);
  const original = fs.lstat;
  let afterBaselineStatfs = false;
  let baseline = true;
  mockVolume(t, () => { if (baseline) afterBaselineStatfs = true; return volume(); });
  t.mock.method(fs, 'lstat', async (file, options) => {
    const stat = await original(file, options);
    if (String(file) === root && afterBaselineStatfs) { afterBaselineStatfs = false; stat.ino += 1n; }
    return stat;
  });
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.equal(summary.state, 'completed');
  assert.equal(summary.volume, null);
  baseline = false;
  assert.equal((await scanner.measureSpace()).comparison, 'baseline-unavailable');
});

for (const [name, overrides] of [
  ['negative available blocks', { bavail: -1n }],
  ['negative total blocks', { blocks: -1n }],
  ['no reported capacity', { blocks: 0n, bavail: 0n }],
  ['zero block size', { bsize: 0n }],
  ['available space exceeding capacity', { bavail: 101n }],
  ['unsafe integer capacity', { blocks: BigInt(Number.MAX_SAFE_INTEGER) }],
  ['missing filesystem signature', { type: undefined }],
  ['non-integer metadata', { bavail: 1.5 }],
]) {
  test(`${name} is never accepted as a baseline or current space value`, async t => {
    const root = await fixture(t);
    mockVolume(t, () => volume(40n, overrides));
    const scanner = new ScanIndex(root);
    assert.equal((await scanner.scan()).volume, null);
    await assert.rejects(scanner.measureSpace(), { code: 'SPACE_UNAVAILABLE' });
    assert.equal(scanner.summary().errors, 0);
  });
}

for (const [name, overrides] of [
  ['filesystem type', { type: 1234n }],
  ['block size with unchanged capacity', { bsize: 512n, blocks: 200n }],
  ['total capacity', { blocks: 200n }],
]) {
  test(`changed ${name} exposes the current sample without comparing different volume signatures`, async t => {
    const root = await fixture(t);
    let next = volume();
    mockVolume(t, () => next);
    const scanner = new ScanIndex(root);
    await scanner.scan();
    next = volume(50n, overrides);
    const result = await scanner.measureSpace();
    assert.equal(result.comparison, 'volume-changed');
    assert.equal(result.delta, null);
    assert.equal(result.current.free, Number(next.bavail * next.bsize));
    assert.equal(result.baseline.free, 40960);
  });
}

test('a disappeared root refuses measurement before statfs can inspect its former location', async t => {
  const root = await fixture(t);
  const scanner = new ScanIndex(root);
  await scanner.scan();
  await fs.rm(root, { recursive: true });
  t.mock.method(fs, 'statfs', async () => { assert.fail('The missing root must be rejected before statfs.'); });
  await assert.rejects(scanner.measureSpace(), { code: 'SPACE_ROOT_CHANGED' });
  assert.equal(scanner.summary().state, 'completed');
});

test('a real root replacement after scanning is rejected without reading replacement contents', async t => {
  const root = await fixture(t);
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'diskharbor-space-backup-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  await fs.rename(root, path.join(parent, 'original'));
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'new.txt'), 'replacement');
  t.mock.method(fs, 'statfs', async () => { assert.fail('The replacement must be rejected before statfs.'); });
  await assert.rejects(scanner.measureSpace(), { code: 'SPACE_ROOT_CHANGED' });
  assert.deepEqual(scanner.summary(), summary);
  assert.equal(scanner.query({ search: 'new.txt' }).total, 0);
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'replacement');
});

for (const changed of ['device', 'inode', 'kind', 'realpath']) {
  test(`a root ${changed} change during statfs invalidates the returned capacity sample`, async t => {
    const root = await fixture(t);
    const scanner = new ScanIndex(root);
    await scanner.scan();
    let changedAfterRead = false;
    mockVolume(t, () => { changedAfterRead = true; return volume(); });
    const originalStat = fs.lstat;
    const originalRealPath = fs.realpath;
    t.mock.method(fs, 'lstat', async (file, options) => {
      const stat = await originalStat(file, options);
      if (changedAfterRead && String(file) === root) {
        if (changed === 'device') stat.dev += 1n;
        if (changed === 'inode') stat.ino += 1n;
        if (changed === 'kind') stat.isDirectory = () => false;
      }
      return stat;
    });
    t.mock.method(fs, 'realpath', async (...args) => changedAfterRead && changed === 'realpath' ? path.join(root, 'changed') : originalRealPath(...args));
    await assert.rejects(scanner.measureSpace(), { code: 'SPACE_ROOT_CHANGED' });
  });
}

test('root timestamp changes alone do not prevent measuring the same volume after cleanup', async t => {
  const root = await fixture(t);
  mockVolume(t, () => volume());
  const scanner = new ScanIndex(root);
  await scanner.scan();
  await fs.writeFile(path.join(root, 'later.txt'), 'normal directory modification');
  assert.equal((await scanner.measureSpace()).comparison, 'comparable');
  assert.equal(scanner.query({ search: 'later.txt' }).total, 0);
});

test('idle and genuinely pending scans reject measurement; a settled cancelled scan may measure', async t => {
  const root = await fixture(t);
  mockVolume(t, () => volume());
  const entered = deferred();
  const release = deferred();
  const original = fs.opendir;
  let cancelled = false;
  t.mock.method(fs, 'opendir', async (...args) => {
    entered.resolve();
    await release.promise;
    return original(...args);
  });
  const scanner = new ScanIndex(root, { shouldCancel: () => cancelled });
  await assert.rejects(scanner.measureSpace(), { code: 'SPACE_SCAN_NOT_READY' });
  const scanning = scanner.scan();
  t.after(() => release.resolve());
  await entered.promise;
  await assert.rejects(scanner.measureSpace(), { code: 'SPACE_SCAN_NOT_READY' });
  cancelled = true;
  await assert.rejects(scanner.measureSpace(), { code: 'SPACE_SCAN_NOT_READY' });
  release.resolve();
  assert.equal((await scanning).state, 'cancelled');
  assert.equal((await scanner.measureSpace()).comparison, 'comparable');
});

test('failed scans refuse measurement even if their initial volume metadata was available', async t => {
  const root = await fixture(t);
  mockVolume(t, () => volume());
  t.mock.method(fs, 'opendir', async () => { throw Object.assign(new Error('Fixture root unreadable.'), { code: 'EACCES' }); });
  const scanner = new ScanIndex(root);
  assert.equal((await scanner.scan()).state, 'error');
  await assert.rejects(scanner.measureSpace(), { code: 'SPACE_SCAN_NOT_READY' });
});

test('concurrent callers cannot add filesystem work until the outstanding sample actually settles', async t => {
  const root = await fixture(t);
  mockVolume(t, () => volume());
  const scanner = new ScanIndex(root);
  await scanner.scan();
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  t.mock.method(fs, 'statfs', async () => {
    calls++;
    entered.resolve();
    await release.promise;
    throw new Error('Fixture capacity unavailable.');
  });
  const first = scanner.measureSpace();
  const rejectedFirst = assert.rejects(first, { code: 'SPACE_UNAVAILABLE' });
  t.after(() => release.resolve());
  await entered.promise;
  await assert.rejects(scanner.measureSpace(), { code: 'SPACE_CHECK_IN_PROGRESS' });
  await assert.rejects(scanner.measureSpace(), { code: 'SPACE_CHECK_IN_PROGRESS' });
  assert.equal(calls, 1);
  release.resolve();
  await rejectedFirst;
  t.mock.method(fs, 'statfs', async () => volume());
  assert.equal((await scanner.measureSpace()).comparison, 'comparable');
});
