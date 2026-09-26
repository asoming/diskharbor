'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { ScanIndex, parseMountInfo, MAX_CLEANUP_MANIFEST_DESCENDANTS, MAX_RESOLVE_PATHS, MAX_RESOLVE_PATH_LENGTH } = require('../electron/scanner.cjs');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'diskharbor-scan-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function visibilityFixture(t) {
  // Keep these owned fixtures outside macOS /private/var temporary paths,
  // which are intentionally treated as explicitly selected system roots.
  const output = path.resolve(__dirname, '..', 'output');
  await fs.mkdir(output, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(output, 'visibility-test-')));
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
  const parentStat = await fs.lstat(path.dirname(report.path), { bigint: true });
  assert.equal(identity.parentDev, parentStat.dev.toString());
  assert.equal(identity.parentIno, parentStat.ino.toString());
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
  const manifest = scanner.cleanupManifest(1);
  assert.equal(manifest.entries.filter(node => node.entry.kind === 'symlink').length, 2);
  assert.equal(manifest.entries.filter(node => node.entry.state === 'skipped').length, 2);
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

test('exact path lookup restores a new scan ID and never consults the filesystem', async t => {
  const root = await fixture(t);
  const folder = path.join(root, 'folder');
  const target = path.join(folder, 'Keep.txt');
  await fs.mkdir(folder);
  await fs.writeFile(target, 'keep');
  const before = new ScanIndex(root);
  assert.deepEqual(before.resolvePaths([root, target]), [null, null]);
  await before.scan();
  const old = before.resolvePaths([target])[0];
  await fs.writeFile(path.join(root, 'new-root-file.txt'), 'new');
  const after = new ScanIndex(root);
  await after.scan();
  const current = after.resolvePaths([target])[0];
  assert.notEqual(current.id, old.id);
  assert.equal(current.path, old.path);
  assert.equal(after.resolvePaths([root])[0].id, 1);
  assert.equal(after.resolvePaths([path.join(folder, 'keep.txt')])[0], null, 'case is never guessed, including case-insensitive hosts');
  assert.equal(after.resolvePaths([`${folder}${path.sep}.${path.sep}Keep.txt`])[0], null, 'lookup does not normalize aliases');
  assert.deepEqual(after.resolvePaths([]), []);
  const duplicate = after.resolvePaths([target, target]);
  duplicate[0].name = 'caller mutation';
  assert.equal(duplicate[1].name, 'Keep.txt');
  assert.equal(after.resolvePaths([target])[0].name, 'Keep.txt');
  await fs.unlink(target);
  // A scan is a snapshot; resolving an existing result must perform no lstat/realpath.
  assert.equal(after.resolvePaths([target])[0].id, current.id);
  const latest = new ScanIndex(root);
  await latest.scan();
  assert.deepEqual(latest.resolvePaths([target]), [null]);
});

test('path lookup validates the entire bounded array without accepting holes or raw bytes', async t => {
  const root = await fixture(t);
  const index = new ScanIndex(root);
  const invalid = [null, root, {}, [null], [1], [Buffer.from(root)], [''], ['relative.txt'], [`${root}\0bad`], [`${root}/\ud800`], new Array(1), Array(MAX_RESOLVE_PATHS + 1).fill(root), [`/${'x'.repeat(MAX_RESOLVE_PATH_LENGTH)}`]];
  for (const paths of invalid) assert.throws(() => index.resolvePaths(paths), { code: 'INVALID_PATHS' });
  assert.deepEqual(index.resolvePaths(Array(MAX_RESOLVE_PATHS).fill(root)), Array(MAX_RESOLVE_PATHS).fill(null));
});

test('incremental path lookup returns discovered entries and leaves undiscovered paths null', async t => {
  const root = await fixture(t);
  const names = ['one.txt', 'two.txt', 'three.txt'];
  await Promise.all(names.map(name => fs.writeFile(path.join(root, name), name)));
  let checked = false;
  let scanner;
  scanner = new ScanIndex(root, { shouldCancel: () => {
    if (scanner.summary().files !== 1) return false;
    const known = scanner.query({ kind: 'file' }).entries[0];
    const unknown = names.map(name => path.join(root, name)).find(file => file !== known.path);
    assert.equal(scanner.summary().state, 'scanning');
    assert.equal(scanner.resolvePaths([known.path])[0].id, known.id);
    assert.equal(scanner.resolvePaths([unknown])[0], null);
    checked = true;
    return true;
  } });
  await scanner.scan();
  assert.equal(checked, true);
  assert.equal(scanner.summary().state, 'cancelled');
  assert.equal(scanner.resolvePaths([root])[0].state, 'partial');
});

test('non-UTF8 display names and a literal filename with the same display never resolve ambiguously', async t => {
  if (process.platform !== 'linux') return t.skip('Linux raw filename and literal backslash fixture.');
  const root = await fixture(t);
  const literal = path.join(root, 'file-\\xff.bin');
  await fs.writeFile(literal, 'ordinary');
  const first = new ScanIndex(root);
  await first.scan();
  assert.equal(first.resolvePaths([literal])[0].name, 'file-\\xff.bin');
  const raw = Buffer.concat([Buffer.from(`${root}/file-`), Buffer.from([0xff]), Buffer.from('.bin')]);
  await fs.writeFile(raw, 'raw');
  const second = new ScanIndex(root);
  await second.scan();
  const entries = second.query({ kind: 'file' }).entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].path, entries[1].path);
  assert.equal(entries.filter(entry => second.entryIdentity(entry.id).unsupportedPath).length, 1);
  assert.deepEqual(second.resolvePaths([literal]), [null]);
  await fs.unlink(literal);
  const third = new ScanIndex(root);
  await third.scan();
  assert.deepEqual(third.resolvePaths([literal]), [null]);
});

test('failure summaries expose bounded cloned codes and a failed file retries only its parent directory', async t => {
  const root = await fixture(t);
  const folder = path.join(root, 'blocked');
  await fs.mkdir(folder);
  for (let index = 0; index < 110; index++) await fs.writeFile(path.join(folder, `${index}.txt`), 'data');
  const original = fs.lstat;
  t.mock.method(fs, 'lstat', async (file, options) => {
    if (path.dirname(String(file)) === folder) throw Object.assign(new Error('private detail should never reach the summary'), { code: 'EACCES' });
    return original(file, options);
  });
  const scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.equal(summary.errors, 110);
  assert.equal(summary.errorDetails.length, 100);
  assert.equal(JSON.stringify(summary).includes('private detail'), false);
  assert.deepEqual(Object.keys(summary.errorDetails[0]).sort(), ['code', 'id']);
  const failed = scanner.entry(summary.errorDetails[0].id);
  assert.equal(failed.state, 'error');
  assert.equal(scanner.resolvePaths([failed.path])[0].id, failed.id);
  assert.equal(scanner.retryTarget(failed.id), folder);
  assert.throws(() => scanner.retryTarget(1), { code: 'INVALID_RETRY_TARGET' });
  for (const value of [0, -1, 1.5, '2', null, 999999]) assert.throws(() => scanner.retryTarget(value), { code: 'INVALID_RETRY_TARGET' });
  summary.errorDetails[0].code = 'MUTATED';
  summary.errorDetails.length = 0;
  assert.equal(scanner.summary().errorDetails.length, 100);
  assert.equal(scanner.summary().errorDetails[0].code, 'EACCES');
});

test('an unreadable directory retries itself and arbitrary error code strings become SCAN_ERROR', async t => {
  const root = await fixture(t);
  const target = path.join(root, 'blocked');
  await fs.mkdir(target);
  const original = fs.opendir;
  t.mock.method(fs, 'opendir', async (file, options) => {
    if (String(file) === target) throw Object.assign(new Error('private message'), { code: 'not a safe code /private/path' });
    return original(file, options);
  });
  const scanner = new ScanIndex(root);
  await scanner.scan();
  const directory = scanner.resolvePaths([target])[0];
  assert.equal(directory.state, 'error');
  assert.equal(scanner.retryTarget(directory.id), target);
  assert.deepEqual(scanner.summary().errorDetails, [{ id: directory.id, code: 'SCAN_ERROR' }]);
});

test('an unreadable non-UTF8 directory cannot produce a string retry target', async t => {
  if (process.platform !== 'linux') return t.skip('Linux raw filename fixture.');
  const root = await fixture(t);
  const raw = Buffer.concat([Buffer.from(`${root}/blocked-`), Buffer.from([0xff])]);
  await fs.mkdir(raw);
  const original = fs.opendir;
  t.mock.method(fs, 'opendir', async (file, options) => {
    if (Buffer.isBuffer(file) && file.equals(raw)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original(file, options);
  });
  const scanner = new ScanIndex(root);
  await scanner.scan();
  const failed = scanner.query({ parentId: 1 }).entries[0];
  assert.equal(failed.state, 'error');
  assert.throws(() => scanner.retryTarget(failed.id), { code: 'UNSUPPORTED_PATH' });
  assert.deepEqual(scanner.resolvePaths([failed.path]), [null]);
});

test('the scan worker exposes path resolution and retry-target routes with explicit errors', { timeout: 10000 }, async t => {
  const root = await fixture(t);
  const target = path.join(root, 'a.txt');
  await fs.writeFile(target, 'data');
  const worker = new Worker(path.join(__dirname, '../electron/scan-worker.cjs'), { workerData: { rootPath: root, scanId: 'worker-path-test', cancelBuffer: new SharedArrayBuffer(4) } });
  t.after(() => worker.terminate());
  await new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', message => { if (message.type === 'progress' && message.summary.state === 'completed') resolve(); });
  });
  let nextId = 0;
  const request = (method, argument) => new Promise(resolve => {
    const id = String(++nextId);
    const listener = message => {
      if (message.type === 'response' && message.id === id) { worker.off('message', listener); resolve(message); }
    };
    worker.on('message', listener);
    worker.postMessage({ type: 'request', id, method, argument });
  });
  const resolved = await request('resolvePaths', [target, path.join(root, 'missing')]);
  assert.equal(resolved.result[0].path, target);
  assert.equal(resolved.result[1], null);
  assert.equal((await request('resolvePaths', ['relative'])).error, 'INVALID_PATHS');
  assert.equal((await request('retryTarget', resolved.result[0].id)).error, 'INVALID_RETRY_TARGET');
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
  assert.deepEqual(scanner.cleanupManifest(1), { entries: [], truncated: false });
});

test('cleanup manifests are isolated index snapshots and do not revisit the filesystem', async t => {
  const root = await fixture(t);
  const folder = path.join(root, 'folder');
  await fs.mkdir(path.join(folder, 'nested'), { recursive: true });
  await fs.writeFile(path.join(folder, 'nested', 'report.txt'), 'data');
  const scanner = new ScanIndex(root);
  assert.deepEqual(scanner.cleanupManifest(1), { entries: [], truncated: false });
  await scanner.scan();
  const directory = scanner.query({ parentId: 1 }).entries[0];
  const initial = scanner.cleanupManifest(directory.id);
  assert.equal(initial.truncated, false);
  assert.deepEqual(initial.entries.map(node => node.entry.name), ['folder', 'nested', 'report.txt']);
  assert.equal(initial.entries.every(node => node.identity.path === node.entry.path), true);
  await fs.rm(folder, { recursive: true });
  assert.deepEqual(scanner.cleanupManifest(directory.id), initial);
  initial.entries[0].entry.name = 'mutated';
  initial.entries[1].identity.ino = 'changed';
  const again = scanner.cleanupManifest(directory.id);
  assert.equal(again.entries[0].entry.name, 'folder');
  assert.notEqual(again.entries[1].identity.ino, 'changed');
  assert.deepEqual(scanner.cleanupManifest(-1), { entries: [], truncated: false });
});

test('cleanup manifests accept the exact descendant limit and mark larger directories truncated', async t => {
  const root = await fixture(t);
  // Small batches bound file descriptors on Windows and macOS CI runners.
  for (let offset = 0; offset < MAX_CLEANUP_MANIFEST_DESCENDANTS; offset += 64) {
    await Promise.all(Array.from({ length: Math.min(64, MAX_CLEANUP_MANIFEST_DESCENDANTS - offset) }, (_, index) =>
      fs.writeFile(path.join(root, `entry-${offset + index}`), ''),
    ));
  }
  const atLimit = new ScanIndex(root);
  await atLimit.scan();
  const manifest = atLimit.cleanupManifest(1);
  assert.equal(manifest.entries.length, MAX_CLEANUP_MANIFEST_DESCENDANTS + 1);
  assert.equal(manifest.truncated, false);
  assert.equal(new Set(manifest.entries.map(node => node.entry.id)).size, manifest.entries.length);
  await fs.writeFile(path.join(root, 'extra'), '');
  const overLimit = new ScanIndex(root);
  await overLimit.scan();
  const truncated = overLimit.cleanupManifest(1);
  assert.equal(truncated.entries.length, MAX_CLEANUP_MANIFEST_DESCENDANTS + 1);
  assert.equal(truncated.truncated, true);
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

test('visibility filters inherit dot ancestors in global search and preserve complete scan totals and manifests', async t => {
  const root = await visibilityFixture(t);
  // Use an explicit path-classification context to exercise an anchored,
  // non-dot app-data directory without reading or writing system locations.
  const platform = process.platform === 'win32' ? 'win32' : 'darwin';
  const appFolder = platform === 'win32' ? 'AppData' : 'Library';
  const files = [
    ['visible1.txt', 11], ['visible2.txt', 29], ['.top.txt', 23],
    ['.secret/needle.txt', 13], ['.secret/ignore.png', 31],
    [`${appFolder}/system.txt`, 17], [`${appFolder}/.nested/match.txt`, 19],
  ];
  for (const [name, bytes] of files) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.alloc(bytes));
  }
  const scanner = new ScanIndex(root, { visibilityContext: { platform, home: root } });
  const summary = await scanner.scan();
  assert.equal(summary.visibility.rootIsSystem, false);
  const manifest = scanner.cleanupManifest(1);
  const all = scanner.query({ kind: 'file', sortBy: 'name', sortDirection: 'asc' });
  assert.equal(all.total, 7);
  assert.equal(Object.hasOwn(all, 'filteredCount'), false);
  assert.equal(summary.logicalBytes, files.reduce((sum, [, bytes]) => sum + bytes, 0));
  assert.equal(summary.files, 7);
  const needle = all.entries.find(entry => entry.name === 'needle.txt');
  assert.equal(needle.hiddenPath, true);
  assert.equal(needle.systemPath, false);
  const system = all.entries.find(entry => entry.name === 'system.txt');
  assert.equal(system.hiddenPath, false);
  assert.equal(system.systemPath, true);
  const both = all.entries.find(entry => entry.name === 'match.txt');
  assert.equal(both.hiddenPath, true);
  assert.equal(both.systemPath, true);
  assert.deepEqual(scanner.query({ search: 'needle', kind: 'file', includeHidden: false }),
    { entries: [], total: 0, filteredCount: 1 });
  const hiddenParent = scanner.query({ search: '.secret', kind: 'directory' }).entries[0];
  assert.deepEqual(scanner.query({ parentId: hiddenParent.id, includeHidden: false }),
    { entries: [], total: 0, filteredCount: 2 });
  const filtered = scanner.query({ category: 'documents', kind: 'file', minSize: 12,
    includeHidden: false, includeSystem: false });
  assert.deepEqual(filtered.entries.map(entry => entry.name), ['visible2.txt']);
  assert.equal(filtered.filteredCount, 4, 'only matching documents at least 12 bytes count as filtered');
  const app = scanner.query({ parentId: 1, kind: 'directory' }).entries.find(entry => entry.name === appFolder);
  assert.equal(app.fileCount, 2);
  assert.equal(app.logicalSize, 36);
  assert.equal(scanner.entry(1).fileCount, 7);
  assert.deepEqual(scanner.summary(), summary);
  assert.deepEqual(scanner.cleanupManifest(1), manifest);
  assert.ok(manifest.entries.some(node => node.entry.id === needle.id));
  assert.ok(manifest.entries.some(node => node.entry.id === both.id));
  assert.equal(scanner.entry(needle.id).path, needle.path, 'direct lookup remains unfiltered');
  assert.deepEqual(scanner.resolvePaths([needle.path]), [needle], 'exact-path resolution remains unfiltered');
});

test('all visibility switch combinations keep independent cached pages, sorting and deduplicated counts', async t => {
  const root = await visibilityFixture(t);
  const platform = process.platform === 'win32' ? 'win32' : 'darwin';
  const appFolder = platform === 'win32' ? 'AppData' : 'Library';
  const definitions = [
    ['visible.txt', 8], ['.hidden/hidden.txt', 16],
    [`${appFolder}/system.txt`, 24], [`${appFolder}/.hidden/both.txt`, 32],
  ];
  for (const [name, size] of definitions) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.alloc(size));
  }
  const scanner = new ScanIndex(root, { visibilityContext: { platform, home: root } });
  await scanner.scan();
  const scenarios = [
    [true, true, ['both.txt', 'hidden.txt', 'system.txt', 'visible.txt'], 0],
    [false, true, ['system.txt', 'visible.txt'], 2],
    [true, false, ['hidden.txt', 'visible.txt'], 2],
    [false, false, ['visible.txt'], 3],
  ];
  for (const [includeHidden, includeSystem, expected, filteredCount] of [...scenarios, ...scenarios.toReversed()]) {
    const query = { kind: 'file', includeHidden, includeSystem, sortBy: 'name', sortDirection: 'asc' };
    const names = [];
    for (let offset = 0; offset <= expected.length; offset++) {
      const page = scanner.query({ ...query, offset, limit: 1 });
      assert.equal(page.total, expected.length);
      assert.equal(page.filteredCount, filteredCount);
      names.push(...page.entries.map(entry => entry.name));
    }
    assert.deepEqual(names, expected);
    const sizeOrder = scanner.query({ ...query, sortBy: 'logicalSize', sortDirection: 'desc' });
    assert.equal(sizeOrder.filteredCount, filteredCount);
    assert.deepEqual(sizeOrder.entries.map(entry => entry.logicalSize), sizeOrder.entries.map(entry => entry.logicalSize).sort((a, b) => b - a));
  }
  const defaultQuery = scanner.query({ kind: 'file' });
  assert.equal(defaultQuery.total, 4);
  assert.equal(Object.hasOwn(defaultQuery, 'filteredCount'), false);
  assert.equal(scanner.query({ kind: 'file', includeHidden: true }).filteredCount, 0);
  assert.equal(scanner.query({ kind: 'file', includeSystem: true }).filteredCount, 0);
  assert.equal(Object.hasOwn(scanner.query({ includeHidden: 'false' }), 'filteredCount'), false);
  const visible = scanner.query({ kind: 'file', includeHidden: false, includeSystem: false }).entries[0];
  visible.hiddenPath = true;
  assert.equal(scanner.entry(visible.id).hiddenPath, false);
  assert.deepEqual(scanner.query({ parentId: 99999, includeSystem: false }), { entries: [], total: 0, filteredCount: 0 });
});

test('explicit hidden roots and hidden outside ancestors do not hide ordinary descendants', async t => {
  const parent = await visibilityFixture(t);
  const root = path.join(parent, '.outside', '.selected');
  await fs.mkdir(path.join(root, '.new-hidden'), { recursive: true });
  await fs.writeFile(path.join(root, 'ordinary.txt'), 'visible');
  await fs.writeFile(path.join(root, '.new-hidden', 'nested.txt'), 'hidden');
  const scanner = new ScanIndex(root);
  await scanner.scan();
  assert.equal(scanner.entry(1).hiddenPath, false);
  const visible = scanner.query({ kind: 'file', includeHidden: false });
  assert.deepEqual(visible.entries.map(entry => entry.name), ['ordinary.txt']);
  assert.equal(visible.filteredCount, 1);
  assert.equal(scanner.query({ kind: 'file', search: 'nested', includeHidden: false }).total, 0);
});

test('an explicitly selected app-data root disables system filtering but keeps new dot-path filtering', async t => {
  const home = await visibilityFixture(t);
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  const root = path.join(home, platform === 'win32' ? 'AppData' : '.cache', 'chosen');
  await fs.mkdir(path.join(root, '.new'), { recursive: true });
  await fs.writeFile(path.join(root, 'ordinary.txt'), 'visible');
  await fs.writeFile(path.join(root, '.new', 'nested.txt'), 'hidden');
  const scanner = new ScanIndex(root, { visibilityContext: { platform, home } });
  const summary = await scanner.scan();
  assert.deepEqual(summary.visibility, { rootIsSystem: true, hiddenRule: 'dot-paths', systemRule: 'known-paths' });
  const systemOff = scanner.query({ kind: 'file', includeSystem: false });
  assert.equal(systemOff.total, 2);
  assert.equal(systemOff.filteredCount, 0);
  assert.ok(systemOff.entries.every(entry => entry.systemPath === false));
  const bothOff = scanner.query({ kind: 'file', includeSystem: false, includeHidden: false });
  assert.deepEqual(bothOff.entries.map(entry => entry.name), ['ordinary.txt']);
  assert.equal(bothOff.filteredCount, 1);
  summary.visibility.rootIsSystem = false;
  assert.equal(scanner.summary().visibility.rootIsSystem, true);
});
