'use strict';

// Run only in a fresh user + mount namespace. All mounts and bytes belong to
// this fixture; this is real mount churn, not removable-hardware validation.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ScanIndex } = require('../electron/scanner.cjs');
const { fixtureIdentity } = require('../scripts/storage-acceptance-support.cjs');
const run = promisify(execFile);
const base = process.env.DISKHARBOR_STORAGE_DIR;
const report = { checks: [], errors: [], boundary: 'Owned Linux user/mount namespace; no physical device disconnect, Windows or macOS verification.' };
const mounted = new Set();

async function command(binary, args) {
  return run(binary, args, { timeout: 10000, maxBuffer: 65536, shell: false });
}
async function mount(args, target) {
  assert.ok(target.startsWith(`${base}${path.sep}`));
  assert.equal(await fs.realpath(target), target);
  await command('mount', [...args, target]);
  mounted.add(target);
}
async function unmount(target) {
  assert.ok(mounted.has(target));
  await command('umount', [target]);
  mounted.delete(target);
}
async function scan(target) {
  const scanner = new ScanIndex(target);
  const summary = await scanner.scan();
  assert.equal(summary.state, 'completed', JSON.stringify(summary));
  assert.equal(summary.errors, 0);
  assert.equal(summary.coverage.boundaryDetection, 'mount-table');
  return { scanner, summary };
}

async function main() {
  assert.equal(process.platform, 'linux');
  assert.equal(path.dirname(base), path.resolve(__dirname, '..', 'output'));
  assert.match(path.basename(base), /^storage-acceptance-[0-9a-f-]+$/);
  const bootstrap = JSON.parse(await fs.readFile(path.join(base, 'bootstrap.json'), 'utf8'));
  assert.deepEqual(fixtureIdentity(base), bootstrap.fixtureIdentity);
  const namespace = await fs.readlink('/proc/self/ns/mnt');
  assert.notEqual(namespace, bootstrap.mountNamespace, 'Never mutate mounts in the caller namespace.');
  assert.equal(process.getuid(), 0, 'The runner must map its own user as namespace root.');
  await command('mount', ['--make-rprivate', '/']);
  report.isolation = { originalMountNamespace: bootstrap.mountNamespace, privateMountNamespace: namespace, privatePropagation: true };

  const source = path.join(base, 'mount-source');
  const other = path.join(base, 'mount-other');
  const root = path.join(base, 'mount-selected');
  const nested = path.join(root, 'same-device-bind');
  for (const target of [source, other, root]) await fs.mkdir(target);
  await fs.mkdir(path.join(source, 'same-device-bind'));
  await fs.writeFile(path.join(source, 'visible.txt'), 'owned selected volume\n');
  await fs.writeFile(path.join(other, 'outside.txt'), 'owned other volume\n');
  await mount(['--bind', source], root);
  await mount(['--bind', other], nested);
  const first = await scan(root);
  assert.equal((await fs.stat(nested)).dev, (await fs.stat(root)).dev);
  assert.equal(first.summary.coverage.skipped.mounts, 1);
  assert.equal(first.scanner.query({ search: 'outside.txt' }).total, 0);
  assert.equal(first.scanner.query({ search: 'visible.txt' }).total, 1);
  report.checks.push('A real same-device bind mount inside the selected root is skipped using mount-table identity; its file is not scanned.');

  await unmount(nested);
  await unmount(root);
  await assert.rejects(first.scanner.measureSpace(), { code: 'SPACE_ROOT_CHANGED' });
  await mount(['--bind', other], root);
  await assert.rejects(first.scanner.measureSpace(), { code: 'SPACE_ROOT_CHANGED' });
  assert.deepEqual(first.scanner.summary(), first.summary);
  const replacement = await scan(root);
  assert.equal(replacement.scanner.query({ search: 'outside.txt' }).total, 1);
  assert.equal((await replacement.scanner.measureSpace()).comparison, 'comparable');
  report.checks.push('Unmounting the selected bind mount, then mounting a different directory with the same device/capacity, rejects the stale root identity; explicit rescan adopts the replacement.');
  await unmount(root);

  const memory = path.join(base, 'owned-memory-volume');
  await fs.mkdir(memory);
  await mount(['-t', 'tmpfs', '-o', 'size=32m,nodev,nosuid', 'tmpfs'], memory);
  const memoryScan = await scan(memory);
  assert.equal(memoryScan.summary.coverage.skipped.virtualFilesystems, 1);
  assert.equal(memoryScan.summary.files, 0);
  const baseline = await memoryScan.scanner.measureSpace();
  const sampleFile = path.join(memory, 'owned-external-allocation.bin');
  const amount = 8 * 1024 * 1024;
  const handle = await fs.open(sampleFile, 'wx', 0o600);
  try { await handle.writeFile(Buffer.alloc(amount, 0x6d)); await handle.sync(); }
  finally { await handle.close(); }
  const allocated = await memoryScan.scanner.measureSpace();
  assert.equal(allocated.comparison, 'comparable');
  assert.equal(allocated.current.free - baseline.current.free, -amount);
  // This unlinks one known test allocation, never a user file or Trash root.
  await fs.unlink(sampleFile);
  const released = await memoryScan.scanner.measureSpace();
  assert.equal(released.current.free, baseline.current.free);
  assert.deepEqual(memoryScan.scanner.summary(), memoryScan.summary);
  report.measurements = { baseline, allocated, released, externalBytes: amount };
  report.checks.push('Real statfs observes an external 8 MiB allocation and its exact release on an otherwise isolated tmpfs, while the prior scan remains unchanged and tmpfs contents stay excluded.');

  const identity = await fs.stat(memory, { bigint: true });
  await command('mount', ['-t', 'tmpfs', '-o', 'remount,size=64m,nodev,nosuid', 'tmpfs', memory]);
  const resizedIdentity = await fs.stat(memory, { bigint: true });
  assert.equal(resizedIdentity.dev, identity.dev);
  assert.equal(resizedIdentity.ino, identity.ino);
  const resized = await memoryScan.scanner.measureSpace();
  assert.equal(resized.comparison, 'volume-changed');
  assert.equal(resized.delta, null);
  assert.equal(resized.current.total, 64 * 1024 * 1024);
  report.measurements.resized = resized;
  report.checks.push('A real capacity remount preserves the root inode/device but is reported as volume-changed with no comparable delta.');
  await unmount(memory);
}

main().catch(error => {
  report.error = String(error.stack || error);
  report.errors.push(report.error);
  report.blocked = typeof error.stderr === 'string' && /(?:permission denied|operation not permitted)/i.test(error.stderr);
  process.exitCode = report.blocked ? 2 : 1;
}).finally(async () => {
  for (const target of [...mounted].reverse()) await unmount(target).catch(error => { report.errors.push(String(error)); process.exitCode = 1; });
  report.result = report.blocked ? 'blocked' : report.errors.length ? 'failed' : 'passed';
  await fs.writeFile(path.join(base, 'mount-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
});
