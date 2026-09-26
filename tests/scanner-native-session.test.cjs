'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const native = require('../electron/native-metadata.cjs');

async function fixture(t) {
  const output = path.resolve(__dirname, '../output');
  await fs.mkdir(output, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(output, 'native-session-')));
  await fs.mkdir(path.join(root, 'child'));
  await fs.mkdir(path.join(root, 'child', 'nested'));
  await fs.writeFile(path.join(root, 'root.txt'), 'root');
  await fs.writeFile(path.join(root, 'child', 'child.txt'), 'child');
  await fs.writeFile(path.join(root, 'child', 'nested', 'nested.txt'), 'nested');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function controlledScanner(t, transform = value => value) {
  // Run the unchanged scanner source with a local native-platform dependency
  // context. Do not alter process.platform or install a production test hook.
  // The transport and its real idle timer are production createNativeSession;
  // only the OS child and attribute responses are explicit synthetic fixtures.
  const platform = process.platform === 'win32' ? 'win32' : 'darwin';
  const sessions = [];
  let policyInstalls = 0;
  const createNativeSession = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.ref = () => {}; child.unref = () => {};
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    child.kill = () => { child.killed = true; resolveClosed(); };
    const requests = [];
    child.stdin.on('data', input => {
      const [id, operation, encoded] = input.toString().trimEnd().split('\t');
      assert.equal(operation, 'M', 'Scanning must only request metadata.');
      const file = Buffer.from(encoded, 'hex').toString('utf8'); requests.push(file);
      const stat = fsSync.lstatSync(file, { bigint: true });
      const parent = fsSync.lstatSync(path.dirname(file), { bigint: true });
      const metadata = transform({
        kind: stat.isDirectory() ? 'directory' : 'file', hidden: false, system: false,
        reparsePoint: false, cloudState: 'resident',
        volume: { mountPath: path.parse(file).root, filesystem: platform === 'win32' ? 'NTFS' : 'apfs', local: true },
        identity: Object.fromEntries(Object.entries({ dev: stat.dev, ino: stat.ino, size: stat.size, nlink: stat.nlink,
          mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, parentDev: parent.dev, parentIno: parent.ino }).map(([key, value]) => [key, String(value)])),
      }, file, sessions.length);
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: Number(id), metadata })}\n`));
    });
    const session = native.createNativeSession({ platform, idleMs: 10, timeoutMs: 1000,
      installPolicy() { policyInstalls++; }, spawnProcess() { return child; } });
    sessions.push({ session, closed, child, requests });
    return session;
  };
  t.after(() => sessions.forEach(({ session }) => session.close()));
  const filename = require.resolve('../electron/scanner.cjs');
  const originalRequire = createRequire(filename);
  const module = { exports: {} };
  const compile = vm.runInThisContext(`(function(require,module,exports,process){${fsSync.readFileSync(filename, 'utf8')}\n})`, { filename });
  compile(name => name === './native-metadata.cjs' ? {
    ...native, createNativeSession, ensureNativePolicy() {},
    getNativePathFlags() { return { hidden: false, system: false, reparsePoint: false, cloudState: 'resident', allocatedSize: null, allocationIdentity: null }; },
  } : originalRequire(name), module, module.exports, { platform });
  return { ScanIndex: module.exports.ScanIndex, sessions, get policyInstalls() { return policyInstalls; } };
}

async function waitForIdleClose(transport) {
  let timer;
  try {
    await Promise.race([transport.closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned helper did not become idle.')), 2000);
    })]);
  } finally { clearTimeout(timer); }
  assert.equal(transport.session.closed, true);
  assert.equal(transport.child.killed, true);
}

test('scanner renews an idle native helper for later directories and the final root check', async t => {
  const root = await fixture(t);
  const harness = controlledScanner(t);
  const index = new harness.ScanIndex(root);
  const scanDirectory = index._scanDirectory;
  index._scanDirectory = async function (...args) {
    await scanDirectory.apply(this, args);
    // A long file-only enumeration can outlive the helper's idle lifetime.
    // Wait for the real short idle callback, never a fixed scan-duration sleep.
    await waitForIdleClose(harness.sessions.at(-1));
  };
  const summary = await index.scan();
  assert.equal(summary.state, 'completed', JSON.stringify(summary.errorDetails));
  assert.equal(summary.errors, 0); assert.equal(summary.files, 3); assert.equal(summary.directories, 3);
  assert.ok(harness.sessions.length >= 4, 'Root, two descendants, and final root verification each need a live session.');
  assert.equal(harness.policyInstalls, harness.sessions.length, 'Every renewed helper must install its safety policy.');
  assert.ok(harness.sessions.every(item => item.session.closed), 'Scan finally closes the last renewed session too.');
  assert.deepEqual(harness.sessions.at(-1).requests, [root]);
});

test('renewing an idle scanner helper still rejects a newly reported placeholder directory', async t => {
  const root = await fixture(t);
  const child = path.join(root, 'child');
  const harness = controlledScanner(t, (metadata, file, generation) =>
    file === child && generation > 1 ? { ...metadata, cloudState: 'placeholder' } : metadata);
  const index = new harness.ScanIndex(root);
  const scanDirectory = index._scanDirectory;
  index._scanDirectory = async function (directory, pending) {
    await scanDirectory.call(this, directory, pending);
    if (directory.entry.path === root) await waitForIdleClose(harness.sessions.at(-1));
  };
  const summary = await index.scan();
  assert.equal(summary.errors, 1);
  assert.equal(summary.files, 1, 'The rejected child must not be enumerated.');
  assert.equal(summary.errorDetails[0].code, 'CLOUD_PLACEHOLDER');
  assert.equal(index.query({ kind: 'file' }).entries[0].path, path.join(root, 'root.txt'));
  assert.ok(harness.sessions.length >= 2);
  assert.equal(harness.policyInstalls, harness.sessions.length);
  assert.ok(harness.sessions.every(item => item.session.closed));
});
