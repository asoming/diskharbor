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
  safeForContent, nativeSafetyReason, matchesNativeIdentity,
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
    [{ volume: { ...local.volume, local: false } }, 'NATIVE_VOLUME_UNVERIFIED'],
  ]) assert.throws(() => safeForContent({ ...local, ...changes }), { code });
  assert.throws(() => safeForContent({ ...local, source: 'guessed' }), { code: 'NATIVE_METADATA_UNAVAILABLE' });
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
