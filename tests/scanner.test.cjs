'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ScanIndex, parseMountInfo } = require('../electron/scanner.cjs');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'diskharbor-scan-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// Platforms/filesystems may omit allocation metadata. Unknown is a supported result.
function reportedAllocation(stat) {
  return stat.blocks == null || stat.blocks < 0 ? null : Number(stat.blocks) * 512;
}

test('nested aggregation, categories, identity and ancestors agree with metadata', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'photo.JPG'), Buffer.alloc(3072));
  await fs.writeFile(path.join(root, 'nested', 'report.pdf'), Buffer.alloc(513));
  await fs.writeFile(path.join(root, 'nested', 'empty'), '');
  const scanner = new ScanIndex(root, { scanId: 'fixture' });
  const summary = await scanner.scan();
  assert.equal(summary.state, 'completed');
  assert.equal(summary.scanId, 'fixture');
  assert.equal(summary.files, 3);
  assert.equal(summary.directories, 2);
  assert.equal(summary.logicalBytes, 3585);
  assert.equal(scanner.entry(1).fileCount, 3);
  assert.equal(scanner.entry(1).childCount, 2);
  assert.equal(scanner.entry(1).state, 'ready');
  const fileEntries = scanner.query({ kind: 'file' }).entries;
  const allocations = (await Promise.all(fileEntries.map(entry => fs.lstat(entry.path)))).map(reportedAllocation);
  const expectedAllocated = allocations.reduce((sum, bytes) => sum + (bytes ?? 0), 0);
  assert.equal(summary.scannedBytes, expectedAllocated);
  assert.equal(scanner.entry(1).allocatedSize, allocations.includes(null) ? null : expectedAllocated);
  assert.equal(summary.categories.reduce((sum, item) => sum + item.bytes, 0), expectedAllocated);
  assert.equal(summary.categories.reduce((sum, item) => sum + item.files, 0), 3);
  assert.equal(summary.categories.find(item => item.category === 'images').files, 1);
  const report = fileEntries.find(entry => entry.name === 'report.pdf');
  const ancestors = scanner.ancestors(report.id);
  assert.deepEqual(ancestors.map(entry => entry.name), [path.basename(root), 'nested']);
  const identity = scanner.entryIdentity(report.id);
  const stat = await fs.lstat(report.path, { bigint: true });
  assert.equal(identity.dev, stat.dev.toString());
  assert.equal(identity.ino, stat.ino.toString());
  assert.equal(identity.mtimeNs, stat.mtimeNs.toString());
  assert.equal(identity.ctimeNs, stat.ctimeNs.toString());
  assert.equal(identity.parentRealPath, await fs.realpath(path.dirname(report.path)));
  if (summary.volume !== null) assert.ok(summary.volume.total >= summary.volume.free);
  assert.deepEqual(scanner.ancestors(1), []);
  assert.equal(scanner.entry(-1), null);
  assert.equal(scanner.entryIdentity(9999), null);
  await assert.rejects(scanner.scan(), /only scan once/);
});

test('hard links keep both paths but allocate their blocks only once', async t => {
  const root = await fixture(t);
  const first = path.join(root, 'original.bin');
  await fs.writeFile(first, Buffer.alloc(12345));
  await fs.mkdir(path.join(root, 'sub'));
  await fs.link(first, path.join(root, 'sub', 'linked.bin'));
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  const files = scanner.query({ kind: 'file' }).entries;
  const stat = await fs.lstat(first);
  const allocation = reportedAllocation(stat);
  assert.equal(summary.files, 2);
  assert.equal(summary.logicalBytes, 24690);
  assert.equal(summary.scannedBytes, allocation ?? 0);
  assert.equal(files.filter(entry => entry.shared).length, 2);
  assert.equal(files.reduce((sum, entry) => sum + (entry.allocatedSize ?? 0), 0), allocation ?? 0);
  assert.equal(files.filter(entry => entry.sharedWith).length, 1);
  assert.equal(scanner.entry(1).allocatedSize, allocation);
});

test('symbolic link loops and outside targets are never traversed', async t => {
  if (process.platform === 'win32') return t.skip('Symlink creation privileges vary on Windows.');
  const root = await fixture(t);
  const outside = await fixture(t);
  await fs.writeFile(path.join(outside, 'not-in-scan.txt'), 'private');
  await fs.mkdir(path.join(root, 'folder'));
  await fs.symlink(root, path.join(root, 'folder', 'loop'));
  await fs.symlink(outside, path.join(root, 'outside'));
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.equal(summary.state, 'completed');
  assert.equal(summary.files, 0);
  assert.equal(summary.directories, 2);
  assert.equal(summary.skipped, 2);
  assert.equal(scanner.query({ search: 'not-in-scan' }).total, 0);
  assert.equal(scanner.query({ limit: 100 }).entries.filter(entry => entry.kind === 'symlink').length, 2);
  assert.equal(scanner.entry(1).fileCount, 0);
});

test('hard-linked symbolic links deduplicate their own blocks without following targets', async t => {
  if (process.platform !== 'linux') return t.skip('POSIX hard link to a symbolic link.');
  const root = await fixture(t);
  const link = path.join(root, 'first-link');
  await fs.symlink('target/'.repeat(40), link);
  await fs.link(link, path.join(root, 'second-link'));
  const stat = await fs.lstat(link);
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.equal(summary.scannedBytes, reportedAllocation(stat) ?? 0);
  assert.equal(summary.files, 0);
  assert.equal(summary.skipped, 2);
  assert.equal(scanner.query({ parentId: 1 }).entries.filter(entry => entry.shared).length, 2);
});

test('sparse file reports logical length independently from allocated blocks', async t => {
  const root = await fixture(t);
  const sparse = path.join(root, 'sparse.bin');
  const handle = await fs.open(sparse, 'w');
  await handle.truncate(32 * 1024 * 1024);
  await handle.close();
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  const entry = scanner.query({ kind: 'file' }).entries[0];
  const stat = await fs.lstat(sparse);
  assert.equal(entry.logicalSize, 32 * 1024 * 1024);
  assert.equal(entry.allocatedSize, reportedAllocation(stat));
  assert.equal(summary.logicalBytes, entry.logicalSize);
  assert.equal(summary.scannedBytes, entry.allocatedSize ?? 0);
});

test('query filters, direct-parent boundaries, pagination and stable sorting', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'sub'));
  for (const [name, size] of [['file10.txt', 100], ['file2.txt', 100], ['photo.png', 20], ['sub/nested.txt', 5]]) {
    await fs.writeFile(path.join(root, name), Buffer.alloc(size));
  }
  const scanner = new ScanIndex(root);
  await scanner.scan();
  const names = scanner.query({ parentId: 1, kind: 'file', sortBy: 'name', sortDirection: 'asc' }).entries.map(entry => entry.name);
  assert.deepEqual(names, ['file2.txt', 'file10.txt', 'photo.png']);
  assert.equal(scanner.query({ search: 'NESTED', kind: 'file' }).total, 1);
  assert.equal(scanner.query({ parentId: 1, search: 'nested' }).total, 0);
  assert.equal(scanner.query({ category: 'documents', minSize: 100 }).total, 2);
  const page = scanner.query({ kind: 'file', sortBy: 'logicalSize', sortDirection: 'desc', offset: 1, limit: 1 });
  assert.equal(page.total, 4);
  assert.deepEqual(page.entries.map(entry => entry.name), ['file10.txt']);
  assert.deepEqual(scanner.query({ parentId: 999 }), { entries: [], total: 0 });
  assert.equal(scanner.query({ limit: 0 }).entries.length, 0);
  const entry = scanner.entry(1);
  entry.name = 'mutated';
  assert.notEqual(scanner.entry(1).name, 'mutated');
});

test('cancellation preserves discovered entries and marks the result partial', async t => {
  const root = await fixture(t);
  await Promise.all(Array.from({ length: 300 }, (_, index) => fs.writeFile(path.join(root, `entry-${index}.txt`), 'data')));
  let scanner;
  const progress = [];
  scanner = new ScanIndex(root, {
    shouldCancel: () => scanner.summary().files >= 20,
    onProgress: summary => progress.push(summary.state),
  });
  const summary = await scanner.scan();
  assert.equal(summary.state, 'cancelled');
  assert.equal(summary.files, 20);
  assert.equal(scanner.query({ kind: 'file' }).total, 20);
  assert.equal(scanner.entry(1).state, 'partial');
  assert.equal(summary.logicalBytes, 80);
  assert.equal(progress.at(-1), 'cancelled');
});

test('event loop can query discovered files and cancel an ongoing scan', async t => {
  const root = await fixture(t);
  await Promise.all(Array.from({ length: 512 }, (_, index) => fs.writeFile(path.join(root, `${index}.txt`), 'content')));
  let cancelled = false;
  let queriedWhileScanning = false;
  const scanner = new ScanIndex(root, { shouldCancel: () => cancelled });
  const timer = setInterval(() => {
    if (scanner.summary().state === 'scanning' && scanner.query({ kind: 'file' }).total > 10) {
      queriedWhileScanning = true;
      cancelled = true;
    }
  }, 1);
  t.after(() => clearInterval(timer));
  await scanner.scan();
  clearInterval(timer);
  assert.equal(queriedWhileScanning, true);
  assert.equal(scanner.summary().state, 'cancelled');
  assert.ok(scanner.summary().files < 512);
});

test('missing root is an explicit error, not an empty successful scan', async t => {
  const root = await fixture(t);
  const scanner = new ScanIndex(path.join(root, 'missing'));
  const summary = await scanner.scan();
  assert.equal(summary.state, 'error');
  assert.equal(summary.errors, 1);
  assert.equal(scanner.entry(1).state, 'error');
  assert.equal(scanner.entry(1).allocatedSize, null);
  assert.equal(scanner.entry(1).error, 'ENOENT');
});

test('a metadata error leaves other files usable and marks ancestors partial', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'readable.txt'), 'ok');
  await fs.writeFile(path.join(root, 'unreadable.txt'), 'fail');
  const original = fs.lstat;
  t.mock.method(fs, 'lstat', async (file, options) => {
    if (String(file) === path.join(root, 'unreadable.txt')) throw Object.assign(new Error('Access denied'), { code: 'EACCES' });
    return original(file, options);
  });
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.equal(summary.state, 'completed');
  assert.equal(summary.errors, 1);
  assert.equal(summary.files, 1);
  assert.equal(scanner.entry(1).state, 'partial');
  const failed = scanner.query({ search: 'unreadable' }).entries[0];
  assert.equal(failed.state, 'error');
  assert.equal(failed.allocatedSize, null);
  assert.equal(failed.error, 'EACCES');
  assert.equal(scanner.entryIdentity(failed.id), null);
});

test('unknown block allocation remains unknown and never falls back to logical size', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'unknown.txt'), Buffer.alloc(123));
  const original = fs.lstat;
  t.mock.method(fs, 'lstat', async (file, options) => {
    const stat = await original(file, options);
    if (String(file).endsWith('unknown.txt')) stat.blocks = undefined;
    return stat;
  });
  const scanner = new ScanIndex(root);
  await scanner.scan();
  assert.equal(scanner.query({ kind: 'file' }).entries[0].allocatedSize, null);
  assert.equal(scanner.entry(1).allocatedSize, null);
  assert.equal(scanner.summary().scannedBytes, 0);
  assert.equal(scanner.summary().logicalBytes, 123);
});

test('unavailable volume statistics do not prevent file metadata scanning', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'ordinary.txt'), 'content');
  t.mock.method(fs, 'statfs', async () => { throw Object.assign(new Error('Volume statistics unavailable'), { code: 'ENOSYS' }); });
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.equal(summary.state, 'completed');
  assert.equal(summary.files, 1);
  assert.equal(summary.logicalBytes, 7);
  assert.equal(summary.volume, null);
});

test('non-UTF8 Linux filenames preserve original identity and cannot become operation strings', async t => {
  if (process.platform !== 'linux') return t.skip('Linux byte filename fixture.');
  const root = await fixture(t);
  const rawPath = Buffer.concat([Buffer.from(`${root}/file-`), Buffer.from([0xff]), Buffer.from('.bin')]);
  await fs.writeFile(rawPath, 'data');
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.equal(summary.files, 1);
  const entry = scanner.query({ kind: 'file' }).entries[0];
  assert.ok(entry.name.includes('\\xff'));
  assert.equal(scanner.entryIdentity(entry.id).unsupportedPath, true);
  assert.equal(scanner.entryIdentity(entry.id).rawPathHex, rawPath.toString('hex'));
});

test('mountinfo parser preserves escaped mount paths and filesystem types', () => {
  const mounts = parseMountInfo('30 1 8:1 / / rw - ext4 /dev/sda rw\n31 30 0:5 / /proc rw - proc proc rw\n32 30 8:2 / /media/My\\040Disk rw - exfat /dev/sdb rw\nmalformed\n');
  assert.deepEqual(mounts, [
    { path: '/', type: 'ext4', device: '8:1' },
    { path: '/proc', type: 'proc', device: '0:5' },
    { path: '/media/My Disk', type: 'exfat', device: '8:2' },
  ]);
});

test('a same-device bind mount is skipped even when scanning through a parent alias', async t => {
  if (process.platform !== 'linux') return t.skip('Linux mountinfo boundary fixture.');
  const root = await fixture(t);
  const aliasRoot = await fixture(t);
  await fs.mkdir(path.join(root, 'inside'));
  await fs.mkdir(path.join(root, 'inside', 'mount'));
  await fs.writeFile(path.join(root, 'inside', 'mount', 'outside.txt'), 'not in this scan');
  await fs.symlink(root, path.join(aliasRoot, 'alias'));
  const original = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file === '/proc/self/mountinfo') return `30 1 8:1 / / rw - ext4 /dev/test rw\n31 30 8:1 /target ${root}/inside/mount rw - ext4 /dev/test rw\n`;
    return original(file, ...args);
  });
  const scanner = new ScanIndex(path.join(aliasRoot, 'alias', 'inside'));
  const summary = await scanner.scan();
  assert.equal(summary.files, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(scanner.entry(1).state, 'partial');
  const mount = scanner.query({ parentId: 1 }).entries[0];
  assert.equal(mount.state, 'skipped');
  assert.equal(mount.allocatedSize, null);
  assert.equal(scanner.query({ search: 'outside.txt' }).total, 0);
});

test('a virtual-filesystem root is explicitly skipped', async t => {
  if (process.platform !== 'linux') return t.skip('Linux mountinfo fixture.');
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'kernel-setting'), 'never open');
  const original = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => file === '/proc/self/mountinfo'
    ? `30 1 0:5 / ${root} rw - proc proc rw\n`
    : original(file, ...args));
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.equal(summary.files, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(scanner.entry(1).state, 'skipped');
  assert.equal(scanner.entry(1).allocatedSize, null);
});

test('directory read permission errors preserve partial results; unreadable file content is not accessed', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('Requires POSIX non-root permission enforcement.');
  const root = await fixture(t);
  const protectedDirectory = path.join(root, 'protected');
  const metadataOnlyFile = path.join(root, 'metadata-only.txt');
  await fs.mkdir(protectedDirectory);
  await fs.writeFile(path.join(protectedDirectory, 'private.txt'), 'private');
  await fs.writeFile(metadataOnlyFile, 'metadata works without reading content');
  await fs.chmod(protectedDirectory, 0);
  await fs.chmod(metadataOnlyFile, 0);
  try {
    const scanner = new ScanIndex(root);
    const summary = await scanner.scan();
    assert.equal(summary.errors, 1);
    assert.equal(summary.files, 1);
    assert.equal(scanner.entry(1).state, 'partial');
    assert.equal(scanner.query({ search: 'metadata-only.txt' }).entries[0].state, 'ready');
    const blocked = scanner.query({ parentId: 1, kind: 'directory' }).entries[0];
    assert.equal(blocked.error, 'EACCES');
    assert.equal(blocked.allocatedSize, null);
  } finally {
    await fs.chmod(protectedDirectory, 0o700);
    await fs.chmod(metadataOnlyFile, 0o600);
  }
});
