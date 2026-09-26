'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  ensureNativePolicy, createNativeSession, nativePaths, validateMetadata,
  safeForContent, nativeSafetyReason, matchesNativeIdentity, getNativePathFlags, nativeAllocatedBytes,
} = require('../electron/native-metadata.cjs');
const { ScanIndex } = require('../electron/scanner.cjs');
const { createPreviewService } = require('../electron/preview.cjs');

function metadata(changes = {}) {
  return {
    kind: 'file', hidden: false, system: false, reparsePoint: false, cloudState: 'resident',
    volume: { mountPath: 'C:\\', filesystem: 'NTFS', local: true },
    identity: { dev: '4', ino: '5', size: '5', nlink: '1', mtimeNs: '6', ctimeNs: '7', parentDev: '4', parentIno: '3' },
    ...changes,
  };
}
function transport(t, respond, options = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; }; child.ref = () => {}; child.unref = () => {};
  let count = 0;
  child.stdin.on('data', input => {
    const fields = input.toString().trimEnd().split('\t');
    count++;
    const output = respond(fields, count);
    if (output != null) queueMicrotask(() => child.stdout.write(typeof output === 'string' ? output : `${JSON.stringify({ id: Number(fields[0]), ...output })}\n`));
  });
  const session = createNativeSession({ platform: 'win32', installPolicy() {}, spawnProcess(program, args, options) {
    assert.equal(program, nativePaths('win32').probe); assert.deepEqual(args, []);
    assert.equal(options.shell, false); return child;
  }, ...options });
  t.after(() => session.close());
  return { session, child, get count() { return count; } };
}

test('native policy must install and read back true; missing or false modules fail closed', () => {
  for (const platform of ['win32', 'darwin']) {
    assert.equal(ensureNativePolicy({ platform, load: () => ({ install: () => true }) }), true);
    for (const load of [() => { throw Error('missing'); }, () => ({ install: () => false }), () => ({ install: () => 1 })]) {
      assert.throws(() => ensureNativePolicy({ platform, load }), { code: 'NATIVE_POLICY_UNAVAILABLE' });
    }
  }
  assert.equal(ensureNativePolicy({ platform: 'linux', load: () => { throw Error('must not load'); } }), true);
});

test('native protocol reuses one child and encodes path as data, including Unicode and shell characters', async t => {
  const names = ['C:\\data\\照片 % # + 文件.txt', 'C:\\data\\$(shell) `name`.txt'];
  const fixture = transport(t, (fields, index) => {
    assert.equal(fields[1], 'M'); assert.equal(Buffer.from(fields[2], 'hex').toString('utf8'), names[index - 1]);
    return { metadata: metadata() };
  });
  for (const name of names) assert.equal((await fixture.session.metadata(name)).cloudState, 'resident');
  assert.equal(fixture.count, 2);
});

test('protocol rejects renderer-style relative, UNC, device, ADS and NUL paths before dispatch', async t => {
  const fixture = transport(t, () => assert.fail('must not dispatch'));
  for (const input of ['relative.txt', '\\\\server\\share\\file', '\\\\?\\C:\\file', 'C:\\file:stream', 'C:\\nul\0.txt', 'C:\\broken\ud800']) {
    await assert.rejects(fixture.session.metadata(input), { code: 'UNSUPPORTED_PATH' });
  }
  assert.equal(fixture.count, 0);
});

test('native metadata schema never converts missing or unknown fields into safe values', () => {
  for (const value of [null, metadata({ hidden: undefined }), metadata({ cloudState: 'local' }), metadata({ volume: { local: true } }), metadata({ identity: { dev: '4' } })]) {
    assert.throws(() => validateMetadata(value, 'win32'), { code: 'NATIVE_METADATA_UNAVAILABLE' });
  }
  const local = validateMetadata(metadata(), 'win32');
  assert.equal(nativeSafetyReason(local), null);
  assert.equal(matchesNativeIdentity({ ...local.identity, size: 5, nlink: 1 }, local), true);
  assert.equal(matchesNativeIdentity({ ...local.identity, ino: '6' }, local), false);
  for (const [changes, code] of [
    [{ cloudState: 'placeholder' }, 'CLOUD_PLACEHOLDER'],
    [{ cloudState: 'unknown' }, 'NATIVE_METADATA_UNAVAILABLE'],
    [{ reparsePoint: true }, 'SYMLINK_PARENT'],
    [{ hidden: true }, 'HIDDEN_PATH'],
    [{ system: true }, 'SYSTEM_PATH'],
    [{ volume: { ...local.volume, local: false } }, 'NATIVE_VOLUME_UNVERIFIED'],
  ]) assert.throws(() => safeForContent({ ...local, ...changes }), { code });
  assert.throws(() => safeForContent({ ...local, source: 'guessed' }), { code: 'NATIVE_METADATA_UNAVAILABLE' });
  assert.equal(nativeSafetyReason({ ...local, hidden: true, system: true }, { allowProtected: true }), null);
});

test('native read accepts only canonical exact-length bytes matching every scan identity field', async t => {
  const value = metadata();
  const expected = { ...value.identity, size: 5, nlink: 1 };
  const f = transport(t, fields => {
    assert.equal(fields[1], 'R'); assert.equal(fields.length, 12);
    assert.deepEqual(fields.slice(4), Object.values(value.identity));
    return { metadata: value, bytes: Buffer.from('hello').toString('base64') };
  });
  const result = await f.session.read('C:\\data\\file.txt', expected, 5);
  assert.equal(result.bytes.toString(), 'hello');
  for (const changed of ['dev', 'ino', 'size', 'nlink', 'mtimeNs', 'ctimeNs', 'parentDev', 'parentIno']) {
    const broken = transport(t, () => ({ metadata: metadata({ identity: { ...value.identity, [changed]: '999' } }), bytes: 'aGVsbG8=' }));
    await assert.rejects(broken.session.read('C:\\data\\file.txt', expected, 5), { code: 'IDENTITY_CHANGED' });
  }
});

test('native read does not release bytes from unsafe or malformed native responses', async t => {
  const expected = { ...metadata().identity, size: 5, nlink: 1 };
  for (const [response, code] of [
    [{ metadata: metadata({ cloudState: 'placeholder' }), bytes: 'aGVsbG8=' }, 'CLOUD_PLACEHOLDER'],
    [{ metadata: metadata(), bytes: 'aGVsbG8' }, 'NATIVE_METADATA_UNAVAILABLE'],
    [{ metadata: metadata(), bytes: 'aGVsbG8\n' }, 'NATIVE_METADATA_UNAVAILABLE'],
    [{ metadata: metadata(), bytes: 'aGk=' }, 'NATIVE_METADATA_UNAVAILABLE'],
    [{ error: 'SHELL_COMMAND' }, 'NATIVE_METADATA_UNAVAILABLE'],
  ]) {
    const f = transport(t, () => response);
    await assert.rejects(f.session.read('C:\\data\\file.txt', expected, 5), { code });
  }
});

test('unexpected response IDs and malformed JSON terminate the owned child and reject outstanding work', async t => {
  for (const output of ['{bad json}\n', '{"id":999,"error":"MISSING_FILE"}\n']) {
    const f = transport(t, () => output);
    await assert.rejects(f.session.metadata('C:\\data\\file.txt'), { code: 'NATIVE_METADATA_UNAVAILABLE' });
    assert.equal(f.session.closed, true); assert.equal(f.child.killed, true);
  }
});

test('bounded native timeout terminates only its helper and prevents late reuse', async t => {
  const f = transport(t, () => null, { timeoutMs: 20 });
  await assert.rejects(f.session.metadata('C:\\data\\file.txt'), { code: 'NATIVE_METADATA_UNAVAILABLE' });
  assert.equal(f.session.closed, true); assert.equal(f.child.killed, true);
  await assert.rejects(f.session.metadata('C:\\data\\file.txt'), { code: 'NATIVE_METADATA_UNAVAILABLE' });
});

test('Windows/macOS real helper and Node identities agree; ordinary local explicit preview and stale refusal', { skip: !['win32', 'darwin'].includes(process.platform) }, async t => {
  // Outside OS temp aliases (macOS /var -> /private/var) and protected application
  // data roots. This fixture belongs only to this test and never uses cloud data.
  const root = path.join(process.cwd(), 'output', `native-unit-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'owned.txt');
  await fs.writeFile(file, '<script>literal</script>\n你好');
  ensureNativePolicy();
  const nativeSession = createNativeSession();
  t.after(() => nativeSession.close());
  const nativeIO = {
    ensureNativePolicy, safeForContent,
    getNativeMetadata: value => nativeSession.metadata(value),
    readNativePreview: (...args) => nativeSession.read(...args),
  };
  const index = new ScanIndex(root);
  const summary = await index.scan();
  assert.equal(summary.state, 'completed'); assert.equal(summary.errors, 0);
  assert.equal(typeof summary.coverage.mountPath, 'string'); assert.ok(summary.coverage.filesystem);
  const entry = index.query({ kind: 'file' }).entries[0];
  const expected = index.entryIdentity(entry.id);
  const info = await nativeSession.metadata(file);
  assert.equal(nativeSafetyReason(info), null);
  if (process.platform === 'win32') {
    const drive = await nativeSession.metadata(path.parse(root).root);
    t.diagnostic(`Owned fixture volume root attributes: hidden=${drive.hidden}, system=${drive.system}; neither is inherited as a content-file flag.`);
  }
  assert.equal(matchesNativeIdentity(expected, info), true);
  const service = createPreviewService({
    getEntry: id => index.entry(id), getIdentity: id => index.entryIdentity(id),
    getScanContext: () => ({ scanId: index.scanId, rootPath: root }), nativeIO,
  });
  const preview = await service.preview(entry.id);
  assert.equal(preview.kind, 'text'); assert.equal(preview.text, '<script>literal</script>\n你好');
  await fs.writeFile(file, 'different content');
  await assert.rejects(service.preview(entry.id), { code: 'IDENTITY_CHANGED' });
  const link = path.join(root, 'redirect');
  await fs.symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  const linkInfo = await nativeSession.metadata(link);
  assert.equal(linkInfo.reparsePoint, true);
  await assert.rejects(nativeSession.metadata(path.join(link, 'owned.txt')), { code: 'SYMLINK_PARENT' });
});


test('native path flag lookup rejects absent or malformed metadata rather than assuming visible', () => {
  const flags = { hidden: true, system: false, reparsePoint: false, cloudState: 'resident', allocatedSize: null, allocationIdentity: null };
  assert.deepEqual(getNativePathFlags('C:\\data\\file.txt', { platform: 'win32', load: () => ({ pathFlags: () => flags }) }), flags);
  for (const load of [() => { throw Error('missing'); }, () => ({}), () => ({ pathFlags: () => ({ hidden: false }) })]) {
    assert.throws(() => getNativePathFlags('C:\\data\\file.txt', { platform: 'win32', load }), { code: 'NATIVE_METADATA_UNAVAILABLE' });
  }
});

test('real native hidden attributes filter descendants; explicit roots remain browsable; synthetic offline is refused', { skip: !['win32', 'darwin'].includes(process.platform) }, async t => {
  const { promisify } = require('node:util');
  const execFile = promisify(require('node:child_process').execFile);
  const root = path.join(process.cwd(), 'output', `native-flags-${randomUUID()}`);
  const folder = path.join(root, 'hidden-native-folder');
  const hiddenFile = path.join(root, 'hidden-native.txt');
  const systemFile = path.join(root, 'system-native.txt');
  const ordinary = path.join(root, 'ordinary.txt');
  await fs.mkdir(folder, { recursive: true });
  await Promise.all([fs.writeFile(path.join(folder, 'child.txt'), 'child'), fs.writeFile(hiddenFile, 'hidden'), fs.writeFile(systemFile, 'system'), fs.writeFile(ordinary, 'ordinary')]);
  const attrib = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'attrib.exe');
  const flag = async (file, value, enable) => {
    if (process.platform === 'win32') await execFile(attrib, [`${enable ? '+' : '-'}${value}`, file]);
    else await execFile('/usr/bin/chflags', [enable ? 'hidden' : 'nohidden', file]);
  };
  t.after(async () => {
    for (const file of [folder, hiddenFile, systemFile, ordinary]) {
      await flag(file, 'H', false).catch(() => {});
      if (process.platform === 'win32') { await flag(file, 'S', false).catch(() => {}); await flag(file, 'O', false).catch(() => {}); }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  await flag(folder, 'H', true); await flag(hiddenFile, 'H', true);
  if (process.platform === 'win32') await flag(systemFile, 'S', true);
  ensureNativePolicy();
  const session = createNativeSession(); t.after(() => session.close());
  const hidden = await session.metadata(hiddenFile);
  assert.equal(hidden.hidden, true); assert.equal(nativeSafetyReason(hidden), 'HIDDEN_PATH');
  assert.equal(getNativePathFlags(hiddenFile).hidden, true);
  const scan = new ScanIndex(root);
  const summary = await scan.scan();
  assert.equal(summary.state, 'completed'); assert.equal(summary.errors, 0);
  assert.equal(summary.visibility.hiddenRule, 'native-and-dot-paths');
  const all = scan.query({ kind: 'file' });
  assert.equal(all.total, 4); assert.equal(scan.query({ kind: 'file', includeHidden: false }).total, 2);
  assert.equal(all.entries.find(item => item.path === path.join(folder, 'child.txt')).hiddenPath, true);
  const explicit = new ScanIndex(folder); await explicit.scan();
  assert.equal(explicit.query({ kind: 'file', includeHidden: false }).total, 1);
  const hiddenEntry = all.entries.find(item => item.path === hiddenFile);
  await assert.rejects(session.read(hiddenFile, scan.entryIdentity(hiddenEntry.id), 6), { code: 'HIDDEN_PATH' });
  if (process.platform === 'win32') {
    assert.equal((await session.metadata(systemFile)).system, true);
    assert.equal(scan.query({ kind: 'file', includeSystem: false }).total, 3);
    await flag(ordinary, 'O', true);
    const offline = await session.metadata(ordinary);
    assert.equal(offline.cloudState, 'placeholder'); assert.equal(getNativePathFlags(ordinary).cloudState, 'placeholder');
    const entry = all.entries.find(item => item.path === ordinary);
    await assert.rejects(session.read(ordinary, scan.entryIdentity(entry.id), 8), { code: 'CLOUD_PLACEHOLDER' });
    await flag(ordinary, 'O', false);
    assert.equal(await fs.readFile(ordinary, 'utf8'), 'ordinary');
    // A real long local path exercises both metadata entry points and the reader.
    const deep = path.join(root, ...Array.from({ length: 20 }, (_, n) => `long-component-${n}`));
    await fs.mkdir(deep, { recursive: true });
    const longFile = path.join(deep, 'long.txt'); await fs.writeFile(longFile, 'long');
    assert.ok(longFile.length > 260);
    const longScan = new ScanIndex(deep); assert.equal((await longScan.scan()).state, 'completed');
    const longEntry = longScan.query({ kind: 'file' }).entries[0];
    assert.equal(getNativePathFlags(longFile).cloudState, 'resident');
    assert.equal((await session.read(longFile, longScan.entryIdentity(longEntry.id), 4)).bytes.toString(), 'long');
  }
});


test('native allocation never substitutes logical size, stale identity or a fabricated zero', () => {
  const stat = { dev: 1n, ino: 2n, size: 99999n, mtimeNs: 3n, ctimeNs: 4n };
  const flags = { allocatedSize: 4096, allocationIdentity: Object.fromEntries(Object.entries(stat).map(([key, value]) => [key, String(value)])), cloudState: 'resident', reparsePoint: false };
  assert.equal(nativeAllocatedBytes(stat, flags), 4096);
  assert.equal(nativeAllocatedBytes(stat, { ...flags, allocatedSize: 0 }), 0);
  assert.equal(nativeAllocatedBytes(stat, { ...flags, allocatedSize: null }), null);
  assert.equal(nativeAllocatedBytes(stat, { ...flags, cloudState: 'placeholder' }), null);
  assert.equal(nativeAllocatedBytes({ ...stat, ino: 3n }, flags), null);
  assert.equal(nativeAllocatedBytes({ ...stat, mtimeNs: 5n }, flags), null);
});

test('Windows NTFS ordinary, sparse and compressed files use physical allocation without reading contents during scanning', { skip: process.platform !== 'win32' }, async t => {
  const { promisify } = require('node:util');
  const execFile = promisify(require('node:child_process').execFile);
  const crypto = require('node:crypto');
  const root = path.join(process.cwd(), 'output', `native-allocation-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  ensureNativePolicy();
  const session = createNativeSession(); t.after(() => session.close());
  assert.equal((await session.metadata(root)).volume.filesystem, 'NTFS', 'This fixture intentionally verifies the NTFS allocation contract.');
  const ordinary = path.join(root, 'ordinary.bin');
  const sparse = path.join(root, 'sparse.bin');
  const compressed = path.join(root, 'compressed.bin');
  const ordinaryBytes = crypto.randomBytes(64 * 1024);
  await fs.writeFile(ordinary, ordinaryBytes);
  await fs.writeFile(sparse, '');
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  await execFile(path.join(system32, 'fsutil.exe'), ['sparse', 'setflag', sparse]);
  const handle = await fs.open(sparse, 'r+');
  await handle.truncate(64 * 1024 * 1024);
  assert.equal((await handle.write(Buffer.alloc(4096, 1), 0, 4096, 0)).bytesWritten, 4096);
  assert.equal((await handle.write(Buffer.alloc(4096, 2), 0, 4096, 64 * 1024 * 1024 - 4096)).bytesWritten, 4096);
  const sparseBeforeFlush = getNativePathFlags(sparse).allocatedSize;
  await handle.sync();
  await handle.close();
  const sparseAfterFlush = getNativePathFlags(sparse).allocatedSize;
  const ranges = await execFile(path.join(system32, 'fsutil.exe'), ['sparse', 'queryrange', sparse]);
  t.diagnostic(`Sparse allocation before/after owned writer flush: ${sparseBeforeFlush}/${sparseAfterFlush}; OS allocated ranges: ${ranges.stdout.trim().slice(0, 1500)}`);
  const verifySparse = await fs.open(sparse, 'r');
  const edge = Buffer.alloc(4096);
  await verifySparse.read(edge, 0, 4096, 0); assert.deepEqual(edge, Buffer.alloc(4096, 1));
  await verifySparse.read(edge, 0, 4096, 64 * 1024 * 1024 - 4096); assert.deepEqual(edge, Buffer.alloc(4096, 2));
  await verifySparse.close();
  // Nonzero repetitive bytes require stored compressed data; all-zero units can
  // legitimately have no allocated clusters and cannot prove a positive sample.
  const compressedBytes = Buffer.alloc(256 * 1024, 'DiskHarbor allocation fixture\n');
  const compressedWriter = await fs.open(compressed, 'w');
  await compressedWriter.writeFile(compressedBytes);
  await compressedWriter.sync();
  await compressedWriter.close();
  const compact = await execFile(path.join(system32, 'compact.exe'), ['/C', '/F', '/Q', compressed]);
  const compressedBeforeFlush = getNativePathFlags(compressed).allocatedSize;
  const compressedFlush = await fs.open(compressed, 'r+');
  await compressedFlush.sync();
  await compressedFlush.close();
  const compressedAfterFlush = getNativePathFlags(compressed).allocatedSize;
  t.diagnostic(`Compressed allocation before/after owned writer flush: ${compressedBeforeFlush}/${compressedAfterFlush}; OS compact result: ${compact.stdout.trim().slice(0, 1500)}`);
  const originalReadFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if ([ordinary, sparse, compressed].includes(String(file))) assert.fail('Scanning must never read these file contents.');
    return originalReadFile(file, ...args);
  });
  const scan = new ScanIndex(root); const summary = await scan.scan();
  assert.equal(summary.state, 'completed'); assert.equal(summary.errors, 0);
  const files = scan.query({ kind: 'file' }).entries;
  const normal = files.find(entry => entry.path === ordinary);
  const hole = files.find(entry => entry.path === sparse);
  const packed = files.find(entry => entry.path === compressed);
  assert.ok(normal.allocatedSize >= ordinaryBytes.length && normal.allocatedSize <= ordinaryBytes.length + 65536);
  assert.equal(hole.logicalSize, 64 * 1024 * 1024);
  assert.ok(hole.allocatedSize >= 8192 && hole.allocatedSize < 1024 * 1024, `Sparse allocation: ${hole.allocatedSize}`);
  assert.equal(packed.logicalSize, 256 * 1024);
  assert.ok(packed.allocatedSize > 0 && packed.allocatedSize < packed.logicalSize, `Compressed allocation: ${packed.allocatedSize}`);
  assert.equal(summary.scannedBytes, files.reduce((sum, entry) => sum + entry.allocatedSize, 0));
  assert.equal(summary.coverage.unknownAllocatedEntries, 0);
  assert.deepEqual(await originalReadFile(ordinary), ordinaryBytes);
  assert.deepEqual(await originalReadFile(compressed), compressedBytes);
  t.diagnostic(`Actual NTFS allocation: normal=${normal.allocatedSize}, sparse=${hole.allocatedSize}/${hole.logicalSize}, compressed=${packed.allocatedSize}/${packed.logicalSize}.`);
});
