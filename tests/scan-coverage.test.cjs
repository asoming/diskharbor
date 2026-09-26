'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ScanIndex } = require('../electron/scanner.cjs');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'diskharbor-coverage-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'kept.txt'), 'retained result');
  return root;
}

function terminalRootStat(t, root, terminal) {
  const original = fs.lstat;
  const open = fs.opendir;
  let enumerationClosed = false;
  let reads = 0;
  // Observe the actual phase rather than counting startup metadata calls.
  t.mock.method(fs, 'opendir', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (String(file) !== root) return handle;
    return {
      read: () => handle.read(),
      async close() { await handle.close(); enumerationClosed = true; },
    };
  });
  t.mock.method(fs, 'lstat', async (file, options) => {
    const stat = await original(file, options);
    if (String(file) === root && enumerationClosed) { reads++; return terminal(stat); }
    return stat;
  });
  return () => reads;
}

test('coverage reports observed device identity and returns detached counters before and after scanning', async t => {
  const root = await fixture(t);
  const scanner = new ScanIndex(root);
  assert.deepEqual(scanner.summary().coverage, {
    deviceId: null, mountPath: null, filesystem: null, boundaryDetection: 'device-only',
    skipped: { mounts: 0, symbolicLinks: 0, virtualFilesystems: 0, specialFiles: 0 },
    unsupportedNames: 0, unknownAllocatedEntries: 0,
  });
  const stat = await fs.lstat(root, { bigint: true });
  const summary = await scanner.scan();
  assert.equal(summary.coverage.deviceId, stat.dev.toString());
  assert.equal(summary.state, 'completed');
  assert.equal(summary.skipped, 0);
  assert.equal(Object.values(summary.coverage.skipped).reduce((sum, count) => sum + count, 0), summary.skipped);
  if (process.platform !== 'linux') {
    assert.equal(summary.coverage.boundaryDetection, 'device-only');
    assert.equal(typeof summary.coverage.mountPath, 'string');
    assert.equal(typeof summary.coverage.filesystem, 'string');
    assert.ok(summary.coverage.filesystem.length > 0);
  }
  summary.coverage.skipped.mounts = 123;
  summary.coverage.deviceId = 'changed';
  summary.coverage.unknownAllocatedEntries = 999;
  const next = scanner.summary();
  assert.equal(next.coverage.skipped.mounts, 0);
  assert.equal(next.coverage.deviceId, stat.dev.toString());
  assert.notEqual(next.coverage.unknownAllocatedEntries, 999);
});

test('allocation unknowns count accepted metadata entries separately from errors and unread subtrees', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, '.hidden'), 'visible metadata');
  await fs.writeFile(path.join(root, 'denied.txt'), 'not zero');
  const original = fs.lstat;
  t.mock.method(fs, 'lstat', async (file, options) => {
    if (String(file) === path.join(root, 'denied.txt')) throw Object.assign(new Error('Fixture denied metadata'), { code: 'EACCES' });
    const stat = await original(file, options);
    if (String(file) === path.join(root, '.hidden')) stat.blocks = undefined;
    if (String(file) === path.join(root, 'kept.txt')) stat.blocks = 8n;
    return stat;
  });
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.equal(summary.state, 'completed');
  assert.equal(scanner.entry(1).state, 'partial');
  assert.equal(summary.coverage.unknownAllocatedEntries, 1);
  assert.equal(summary.coverage.unsupportedNames, 0);
  assert.equal(summary.errors, 1);
  assert.equal(summary.scannedBytes, 4096);
  assert.equal(summary.files, 2);
  assert.equal(scanner.query({ search: '.hidden' }).entries[0].allocatedSize, null);
});

test('a real symbolic link is counted once without following its target or changing existing skip semantics', async t => {
  if (process.platform === 'win32') return t.skip('Creating symlinks depends on Windows privileges.');
  const root = await fixture(t);
  const outside = await fixture(t);
  await fs.writeFile(path.join(outside, 'not-in-scope.txt'), 'not scanned');
  await fs.symlink(outside, path.join(root, 'link'));
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.equal(summary.coverage.skipped.symbolicLinks, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.files, 1);
  assert.equal(scanner.query({ search: 'not-in-scope.txt' }).total, 0);
  assert.equal(scanner.query({ kind: 'symlink' }).entries[0].state, 'skipped');
  assert.equal(scanner.entry(1).state, 'ready');
});

test('different-device directories and special files each count one skipped entry, never unknown descendants', async t => {
  const root = await fixture(t);
  const mounted = path.join(root, 'mounted');
  await fs.mkdir(mounted);
  await fs.writeFile(path.join(mounted, 'outside.txt'), 'outside');
  const special = path.join(root, 'special');
  await fs.writeFile(special, 'ordinary fixture with mocked type');
  const original = fs.lstat;
  t.mock.method(fs, 'lstat', async (file, options) => {
    const stat = await original(file, options);
    if (String(file) === mounted) stat.dev += 1n;
    if (String(file) === special) { stat.isDirectory = () => false; stat.isFile = () => false; stat.isSymbolicLink = () => false; }
    return stat;
  });
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.deepEqual(summary.coverage.skipped, { mounts: 1, symbolicLinks: 0, virtualFilesystems: 0, specialFiles: 1 });
  assert.equal(summary.skipped, 2);
  assert.equal(summary.files, 1);
  assert.equal(scanner.entry(1).state, 'partial');
  assert.equal(scanner.query({ search: 'outside.txt' }).total, 0);
});

test('Linux mount coverage identifies the containing mount and skips same-device bind entries', async t => {
  if (process.platform !== 'linux') return t.skip('Linux mount-table metadata.');
  const root = await fixture(t);
  const mount = path.join(root, 'bind');
  await fs.mkdir(mount);
  await fs.writeFile(path.join(mount, 'unread.txt'), 'unread');
  const original = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => file === '/proc/self/mountinfo'
    ? `30 1 8:1 / / rw - ext4 /dev/fixture rw\n31 30 8:1 /target ${mount} rw - ext4 /dev/fixture rw\n`
    : original(file, ...args));
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.equal(summary.coverage.boundaryDetection, 'mount-table');
  assert.equal(summary.coverage.mountPath, '/');
  assert.equal(summary.coverage.filesystem, 'ext4');
  assert.equal(summary.coverage.skipped.mounts, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(scanner.query({ search: 'unread.txt' }).total, 0);
});

test('virtual filesystem roots retain the skipped-root result and identify the exclusion reason', async t => {
  if (process.platform !== 'linux') return t.skip('Linux virtual filesystem classification.');
  const root = await fixture(t);
  const original = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => file === '/proc/self/mountinfo'
    ? `30 1 0:5 / ${root} rw - proc proc rw\n`
    : original(file, ...args));
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.equal(summary.state, 'completed');
  assert.equal(scanner.entry(1).state, 'skipped');
  assert.equal(summary.files, 0);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(summary.coverage.skipped, { mounts: 0, symbolicLinks: 0, virtualFilesystems: 1, specialFiles: 0 });
  assert.equal(summary.coverage.mountPath, root);
  assert.equal(summary.coverage.filesystem, 'proc');
});

test('unavailable or empty mount tables report device-only detection without inventing mount identity', async t => {
  if (process.platform !== 'linux') return t.skip('Linux mount-table fallback.');
  const root = await fixture(t);
  const original = fs.readFile;
  let fail = true;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file !== '/proc/self/mountinfo') return original(file, ...args);
    if (fail) throw Object.assign(new Error('Fixture mount table unavailable'), { code: 'EACCES' });
    return '';
  });
  for (const unavailable of [true, false]) {
    fail = unavailable;
    const summary = await new ScanIndex(root).scan();
    assert.equal(summary.state, 'completed');
    assert.equal(summary.coverage.boundaryDetection, 'device-only');
    assert.equal(summary.coverage.mountPath, null);
    assert.equal(summary.coverage.filesystem, null);
    assert.equal(typeof summary.coverage.deviceId, 'string');
  }
});

test('a usable mount table without a matching root leaves root mount metadata unknown', async t => {
  if (process.platform !== 'linux') return t.skip('Linux mount-table metadata.');
  const root = await fixture(t);
  const original = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => file === '/proc/self/mountinfo'
    ? '30 1 8:1 / /unrelated-fixture-mount rw - ext4 /dev/fixture rw\n'
    : original(file, ...args));
  const summary = await new ScanIndex(root).scan();
  assert.equal(summary.coverage.boundaryDetection, 'mount-table');
  assert.equal(summary.coverage.mountPath, null);
  assert.equal(summary.coverage.filesystem, null);
});

test('unsupportedNames counts affected indexed paths, including children below an invalid-byte name', async t => {
  if (process.platform !== 'linux') return t.skip('Linux raw-byte path fixture.');
  const root = await fixture(t);
  const rawDirectory = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff])]);
  await fs.mkdir(rawDirectory);
  await fs.writeFile(Buffer.concat([rawDirectory, Buffer.from('/normal.txt')]), 'child');
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.equal(summary.coverage.unsupportedNames, 2);
  assert.equal(summary.errors, 0);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.files, 2);
  assert.equal(scanner.query({ search: 'normal.txt' }).total, 1);
});

for (const code of ['ENOENT', 'EIO', 'ENODEV']) {
  test(`a terminal root ${code} becomes an explicit error while keeping discovered results`, async t => {
    const root = await fixture(t);
    const reads = terminalRootStat(t, root, () => { throw Object.assign(new Error(`Fixture ${code}`), { code }); });
    const scanner = new ScanIndex(root);
    const summary = await scanner.scan();
    assert.equal(reads(), 1);
    assert.equal(summary.state, 'error');
    assert.equal(summary.errors, 1);
    assert.deepEqual(summary.errorDetails, [{ id: 1, code }]);
    assert.equal(scanner.entry(1).state, 'error');
    assert.equal(scanner.entry(1).allocatedSize, null);
    assert.equal(summary.files, 1);
    assert.equal(summary.logicalBytes, Buffer.byteLength('retained result'));
    const file = scanner.query({ kind: 'file' }).entries[0];
    assert.equal(file.state, 'ready');
    assert.equal(summary.scannedBytes, file.allocatedSize ?? 0);
    assert.equal(summary.coverage.deviceId, scanner.entryIdentity(1).dev);
  });
}

for (const changed of ['device', 'inode', 'kind']) {
  test(`terminal root ${changed} replacement is ESTALE without scanning replacement contents`, async t => {
    const root = await fixture(t);
    terminalRootStat(t, root, stat => {
      if (changed === 'device') stat.dev += 1n;
      if (changed === 'inode') stat.ino += 1n;
      if (changed === 'kind') { stat.isDirectory = () => false; stat.isFile = () => true; }
      return stat;
    });
    const scanner = new ScanIndex(root);
    const summary = await scanner.scan();
    assert.equal(summary.state, 'error');
    assert.deepEqual(summary.errorDetails, [{ id: 1, code: 'ESTALE' }]);
    assert.equal(summary.files, 1);
    assert.equal(summary.logicalBytes, Buffer.byteLength('retained result'));
  });
}

test('a real temporary root replacement after enumeration is ESTALE and retains only the original indexed results', async t => {
  const root = await fixture(t);
  const backupParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'diskharbor-coverage-backup-')));
  t.after(() => fs.rm(backupParent, { recursive: true, force: true }));
  const backup = path.join(backupParent, 'original');
  const original = fs.opendir;
  let replaced = false;
  t.mock.method(fs, 'opendir', async (file, ...args) => {
    const handle = await original(file, ...args);
    if (String(file) !== root) return handle;
    return {
      read: () => handle.read(),
      async close() {
        // Only freshly-created test directories are renamed; the real handle is closed first.
        await handle.close();
        await fs.rename(root, backup);
        await fs.mkdir(root);
        await fs.writeFile(path.join(root, 'replacement.txt'), 'replacement must not appear in the prior snapshot');
        replaced = true;
      },
    };
  });
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.equal(replaced, true);
  assert.equal(summary.state, 'error');
  assert.deepEqual(summary.errorDetails, [{ id: 1, code: 'ESTALE' }]);
  assert.equal(summary.files, 1);
  assert.equal(summary.logicalBytes, Buffer.byteLength('retained result'));
  const files = scanner.query({ kind: 'file' }).entries;
  assert.deepEqual(files.map(entry => entry.name), ['kept.txt']);
  assert.equal(summary.scannedBytes, files[0].allocatedSize ?? 0);
  assert.notEqual((await fs.lstat(root, { bigint: true })).ino.toString(), scanner.entryIdentity(1).ino);
  assert.equal((await fs.readFile(path.join(backup, 'kept.txt'), 'utf8')), 'retained result');
});

test('directory modification time alone is not treated as root identity replacement', async t => {
  const root = await fixture(t);
  terminalRootStat(t, root, stat => { stat.mtimeNs += 1000000n; stat.ctimeNs += 1000000n; return stat; });
  const summary = await new ScanIndex(root).scan();
  assert.equal(summary.state, 'completed');
  assert.equal(summary.errors, 0);
});

test('an already cancelled scan does not start a final root metadata request', async t => {
  const root = await fixture(t);
  let cancelled = false;
  const reads = terminalRootStat(t, root, () => { throw new Error('Final stat must not run after cancellation.'); });
  const original = fs.opendir;
  t.mock.method(fs, 'opendir', async (...args) => {
    const handle = await original(...args);
    return {
      async read() { const entry = await handle.read(); if (!entry) cancelled = true; return entry; },
      close: () => handle.close(),
    };
  });
  const summary = await new ScanIndex(root, { shouldCancel: () => cancelled }).scan();
  assert.equal(summary.state, 'cancelled');
  assert.equal(summary.errors, 0);
  assert.equal(reads(), 0);
});

test('cancellation arriving during the final metadata call retains the cancelled terminal state', async t => {
  const root = await fixture(t);
  let cancelled = false;
  const reads = terminalRootStat(t, root, () => {
    cancelled = true;
    throw Object.assign(new Error('Fixture failure after cancellation'), { code: 'EIO' });
  });
  const summary = await new ScanIndex(root, { shouldCancel: () => cancelled }).scan();
  assert.equal(reads(), 1);
  assert.equal(summary.state, 'cancelled');
  assert.equal(summary.errors, 0);
  assert.equal(summary.files, 1);
});

test('a root already marked unreadable is not subjected to another terminal request', async t => {
  const root = await fixture(t);
  const reads = terminalRootStat(t, root, () => { throw new Error('Root already failed.'); });
  t.mock.method(fs, 'opendir', async () => { throw Object.assign(new Error('Fixture unavailable directory'), { code: 'ENODEV' }); });
  const summary = await new ScanIndex(root).scan();
  assert.equal(reads(), 0);
  assert.equal(summary.state, 'error');
  assert.equal(summary.errors, 1);
  assert.deepEqual(summary.errorDetails, [{ id: 1, code: 'ENODEV' }]);
});
