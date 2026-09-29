'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { ScanIndex } = require('../electron/scanner.cjs');
const { nativePaths } = require('../electron/native-metadata.cjs');

test('real Windows explicit read denial remains an incomplete scan without automatic elevation', {
  skip: process.platform !== 'win32', timeout: 60000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'diskharbor-owned-acl-')));
  const denied = path.join(root, 'read-denied-child');
  const kept = path.join(root, 'kept.txt');
  const unread = path.join(denied, 'not-discovered.txt');
  const keptContent = 'This readable sibling remains in the scan.';
  const unreadContent = 'Only this test owns the denied directory and its data.';
  const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  const changeAcl = args => execFile(icacls, args, {
    shell: false, windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024,
  });
  let attemptedDeny = false;
  let policyModule;
  let originalExports;
  let elevationRequests = 0;
  let cleanupFailure;
  try {
    await fs.mkdir(denied);
    await fs.writeFile(kept, keptContent);
    await fs.writeFile(unread, unreadContent);
    assert.deepEqual(await fs.readdir(denied), ['not-discovered.txt']);

    const policyPath = require.resolve(nativePaths('win32').policy);
    const policy = require(policyPath);
    const beforeElevation = policy.elevationStatus();
    assert.equal(typeof beforeElevation, 'boolean');
    t.diagnostic(`Native token elevated=${beforeElevation}; explicit deny must still be reported, including on administrator CI runners.`);
    policyModule = require.cache[policyPath];
    originalExports = policyModule.exports;
    // Keep all metadata functions native. Intercept only the consent entry
    // point so a regression cannot open an actual UAC prompt in this test.
    const guardedPolicy = Object.create(policy);
    Object.defineProperty(guardedPolicy, 'restartElevated', { value() {
      elevationRequests++;
      throw new Error('UNEXPECTED_AUTOMATIC_ELEVATION');
    } });
    policyModule.exports = guardedPolicy;

    // RD is read data/list directory only. No inheritance flags, /T, ACL
    // reset, ownership change, write-DAC denial or delete denial are used.
    // The well-known Everyone SID avoids localized account-name guesses.
    attemptedDeny = true;
    await changeAcl([denied, '/deny', '*S-1-1-0:(RD)']);
    await assert.rejects(fs.readdir(denied), error => error.code === 'EACCES' || error.code === 'EPERM',
      'The fixture must actually refuse enumeration; an administrator token does not make the explicit deny disappear.');

    const deadline = Date.now() + 20000;
    const scanner = new ScanIndex(root, { scanId: 'owned-windows-acl', shouldCancel: () => Date.now() >= deadline });
    const summary = await scanner.scan();
    assert.equal(summary.state, 'completed');
    assert.equal(summary.files, 1);
    assert.equal(summary.logicalBytes, Buffer.byteLength(keptContent));
    assert.equal(summary.errors, 1);
    assert.equal(scanner.entry(1).state, 'partial');
    const [deniedEntry, keptEntry, unreadEntry] = scanner.resolvePaths([denied, kept, unread]);
    assert.ok(deniedEntry);
    assert.equal(deniedEntry.state, 'error');
    assert.ok(['EACCES', 'EPERM'].includes(deniedEntry.error));
    assert.equal(deniedEntry.allocatedSize, null);
    assert.deepEqual(summary.errorDetails, [{ id: deniedEntry.id, code: deniedEntry.error }]);
    assert.equal(keptEntry.state, 'ready');
    assert.equal(keptEntry.logicalSize, Buffer.byteLength(keptContent));
    assert.equal(scanner.entry(1).allocatedSize, keptEntry.allocatedSize,
      'The partial parent retains the known sibling subtotal, not a claim that unread descendants are empty.');
    assert.equal(unreadEntry, null);
    assert.equal(elevationRequests, 0, 'A scan error must not request authorization or invoke runas.');
    assert.equal(policy.elevationStatus(), beforeElevation);
  } finally {
    if (policyModule) policyModule.exports = originalExports;
    try {
      // Remove only the explicit deny added to this newly created child. Keep
      // inherited permissions unchanged and verify its own data is intact.
      if (attemptedDeny) {
        await changeAcl([denied, '/remove:d', '*S-1-1-0']);
        assert.equal(await fs.readFile(unread, 'utf8'), unreadContent);
      }
    } catch (error) { cleanupFailure = error; }
    try { await fs.rm(root, { recursive: true, force: true }); }
    catch (error) { cleanupFailure = cleanupFailure ? new AggregateError([cleanupFailure, error], 'Owned ACL fixture cleanup failed') : error; }
    if (cleanupFailure) throw cleanupFailure;
  }
});
