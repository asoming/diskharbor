'use strict';

// No window, renderer override or production bypass: this acceptance harness
// wires the production scanner/cleanup/history to Electron's native Trash API.
const { app, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { ScanIndex } = require('../electron/scanner.cjs');
const { createCleanupService } = require('../electron/cleanup.cjs');
const { createHistoryStore } = require('../electron/history.cjs');
const run = promisify(execFile);
const base = process.env.DISKHARBOR_STORAGE_DIR;
assert.equal(process.platform, 'linux');
assert.equal(path.dirname(base), path.resolve(__dirname, '..', 'output'));
assert.match(path.basename(base), /^storage-acceptance-[0-9a-f-]+$/);
const root = path.join(base, 'files');
const trashRoot = path.join(base, 'xdg-data', 'Trash');
const historyFile = path.join(base, 'user-data', 'operation-history.json');
const history = createHistoryStore(historyFile);
const report = { checks: [], errors: [], nativeTrashCalls: 0, restorations: [],
  boundary: 'Production scanner, cleanup and journal with Electron native Trash; private GIO API restoration/removal. No UI confirmation, file-manager GUI, Windows/macOS or physical-removal acceptance.' };
app.setPath('userData', path.dirname(historyFile));
app.setPath('sessionData', path.join(base, 'session'));
app.commandLine.appendSwitch('disable-gpu');
let scanner;
let allowedPath;
const cleanup = createCleanupService({
  getEntry: id => scanner.entry(id), getIdentity: id => scanner.entryIdentity(id),
  getManifest: id => scanner.cleanupManifest(id), getScanContext: () => scanner.summary(),
  historyStore: history,
  trashItem: async target => {
    assert.equal(target, allowedPath, 'Only the exact confirmed fixture target can reach native Trash.');
    allowedPath = null;
    report.nativeTrashCalls++;
    await shell.trashItem(target);
  },
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = file => fs.lstat(file).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

async function scan() {
  scanner = new ScanIndex(root);
  const summary = await scanner.scan();
  assert.equal(summary.state, 'completed');
  assert.equal(summary.errors, 0);
  return summary;
}
async function ownedEntry(original) {
  const matches = [];
  for (const name of await fs.readdir(path.join(trashRoot, 'info'))) {
    if (!name.endsWith('.trashinfo')) continue;
    const infoPath = path.join(trashRoot, 'info', name);
    const info = await fs.readFile(infoPath, 'utf8');
    const encoded = info.match(/^Path=(.*)$/m)?.[1];
    if (encoded && decodeURIComponent(encoded) === original) {
      const trashName = name.slice(0, -10);
      matches.push({ original, name: trashName, payload: path.join(trashRoot, 'files', trashName), infoPath });
    }
  }
  assert.equal(matches.length, 1);
  assert.equal(await exists(matches[0].payload), true);
  return matches[0];
}
async function trash(target) {
  assert.ok(target.startsWith(`${root}${path.sep}`));
  await scan();
  const entry = scanner.resolvePaths([target])[0];
  assert.ok(entry);
  const plan = await cleanup.plan([entry.id]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].eligible, true, JSON.stringify(plan));
  const record = await cleanup.execute(plan.id, async confirmation => {
    assert.deepEqual(confirmation.items.map(item => item.path), [target]);
    allowedPath = target;
    return true;
  });
  assert.equal(record.success, 1);
  assert.equal(record.failed, 0);
  assert.equal(record.items[0].status, 'trashed');
  assert.equal(record.spaceMeasurement.status, 'comparable');
  assert.equal(record.freeSpaceDelta, record.spaceMeasurement.after.free - record.spaceMeasurement.before.free);
  assert.equal(Object.hasOwn(record, 'releasedBytes'), false);
  assert.equal(await exists(target), false);
  return { ...(await ownedEntry(target)), record };
}
async function external(action, entry) {
  const result = await run('/usr/bin/python3', [path.join(__dirname, 'storage-acceptance-gio.py'), action, entry.name, entry.original],
    { timeout: 15000, maxBuffer: 65536, shell: false, env: process.env });
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.nativeOriginalPath, entry.original);
  assert.equal(evidence.result, 'passed');
  return evidence;
}
async function assertRestored(entry) {
  assert.equal(await exists(entry.original), true);
  assert.equal(await exists(entry.payload), false);
  assert.equal(await exists(entry.infoPath), false);
}
async function freezeHistory() {
  return { bytes: await fs.readFile(historyFile), records: await history.list(), summary: scanner.summary() };
}
async function assertUnchanged(state) {
  assert.deepEqual(await fs.readFile(historyFile), state.bytes);
  assert.deepEqual(await history.list(), state.records);
  assert.deepEqual(await createHistoryStore(historyFile).list(), state.records);
  assert.deepEqual(scanner.summary(), state.summary);
}
function assertSample(value) {
  assert.equal(value.comparison, 'comparable');
  assert.equal(value.delta, value.current.free - value.baseline.free);
  assert.ok(value.current.measuredAt >= value.baseline.measuredAt);
  assert.ok(value.current.free >= 0 && value.current.free <= value.current.total);
}

async function main() {
  report.runtime = { platform: process.platform, electron: process.versions.electron, node: process.versions.node };
  report.runtimeSources = Object.fromEntries(await Promise.all(['scanner.cjs', 'cleanup.cjs', 'history.cjs', 'volume-space.cjs'].map(async name =>
    [name, hash(await fs.readFile(path.join(__dirname, '..', 'electron', name)))])));
  const isolation = JSON.parse(await fs.readFile(path.join(base, 'isolation.json'), 'utf8'));
  assert.equal(isolation.privateBus, true);
  assert.equal(isolation.daemonEnvironmentVerified, true);
  assert.equal(process.env.XDG_DATA_HOME, path.join(base, 'xdg-data'));
  await fs.mkdir(root, { mode: 0o700 });
  assert.equal((await fs.stat(root)).dev, (await fs.stat(process.env.XDG_DATA_HOME)).dev);
  assert.equal(await exists(trashRoot), false, 'Start with a fresh fixture, never an existing user Trash.');
  report.isolation = isolation;
  const sentinel = path.join(root, 'unselected-sentinel.txt');
  const sentinelBytes = Buffer.from('Must remain unselected.\n');
  await fs.writeFile(sentinel, sentinelBytes);
  const trashSentinel = path.join(root, 'unrelated-trash-sentinel.txt');
  const trashBytes = Buffer.from('Must remain in the private Trash.\n');
  await fs.writeFile(trashSentinel, trashBytes);
  const untouched = await trash(trashSentinel);
  const untouchedInfo = await fs.readFile(untouched.infoPath);
  report.checks.push('Verified private bus/GVfs/XDG isolation and an exact-path confirmation before real native Trash; an unrelated private Trash item is retained as a sentinel.');

  const binary = Buffer.from([0, 1, 127, 128, 255, 10, 13, 32]);
  for (const name of ['照片 % # + 文件.bin', '反斜线\\与鲸鱼🐋.bin']) {
    const target = path.join(root, name);
    await fs.writeFile(target, binary);
    const entry = await trash(target);
    const state = await freezeHistory();
    await external('restore', entry);
    await assertRestored(entry);
    assert.deepEqual(await fs.readFile(target), binary);
    await assertUnchanged(state);
    assert.equal(scanner.resolvePaths([target])[0].id > 0, true);
    await scan();
    assert.equal(scanner.resolvePaths([target])[0].state, 'ready');
    report.restorations.push({ name, originalNameRestored: true, sha256: hash(binary), recordId: entry.record.id });
  }
  report.checks.push('Chinese, emoji, backslash and URI punctuation filenames are restored byte-for-byte under their exact original names using GIO native byte-string metadata; external restore does not rewrite history or old scan data.');

  const directory = path.join(root, '中文文件夹 # %');
  await fs.mkdir(path.join(directory, '嵌套', '空目录'), { recursive: true });
  await fs.writeFile(path.join(directory, '嵌套', '数据.bin'), binary);
  const folder = await trash(directory);
  await external('restore', folder);
  await assertRestored(folder);
  assert.deepEqual(await fs.readFile(path.join(directory, '嵌套', '数据.bin')), binary);
  assert.equal((await fs.stat(path.join(directory, '嵌套', '空目录'))).isDirectory(), true);
  report.checks.push('A Chinese directory restores its original name, nested binary contents and empty child directory after one native directory Trash call.');

  const conflictPath = path.join(root, '同名冲突.txt');
  await fs.writeFile(conflictPath, 'original\n');
  const conflict = await trash(conflictPath);
  await fs.writeFile(conflictPath, 'new copy\n');
  await assert.rejects(external('restore', conflict));
  assert.equal(await fs.readFile(conflictPath, 'utf8'), 'new copy\n');
  assert.equal(await fs.readFile(conflict.payload, 'utf8'), 'original\n');
  assert.equal(await exists(conflict.infoPath), true);
  await fs.rename(conflictPath, path.join(root, 'preserved-conflicting-copy.txt'));
  await external('restore', conflict);
  await assertRestored(conflict);
  assert.equal(await fs.readFile(conflictPath, 'utf8'), 'original\n');
  report.checks.push('Native GIO restoration refuses a same-name Chinese file conflict without overwriting either copy; moving the test-created new copy aside allows restoration.');

  const externalPath = path.join(root, '仅供外部移除验证.bin');
  const externalBytes = Buffer.alloc(16 * 1024 * 1024, 0x7b);
  await fs.writeFile(externalPath, externalBytes);
  const removable = await trash(externalPath);
  assert.equal(hash(await fs.readFile(removable.payload)), hash(externalBytes));
  const state = await freezeHistory();
  const before = await scanner.measureSpace();
  await external('remove-owned-item', removable);
  const after = await scanner.measureSpace();
  assertSample(before);
  assertSample(after);
  assert.equal(await exists(removable.payload), false);
  assert.equal(await exists(removable.infoPath), false);
  assert.equal(await exists(removable.original), false);
  await assertUnchanged(state);
  report.externalSpaceCheck = { before, after, observedChange: after.current.free - before.current.free,
    fixturePayloadBytes: externalBytes.length, attributedToCleanup: false };
  report.checks.push('After an external GIO actor removes exactly one verified private Trash item, production measureSpace returns fresh timestamped volume samples; it does not attribute the change to DiskHarbor or rewrite the old scan/history.');

  assert.deepEqual(await fs.readFile(sentinel), sentinelBytes);
  assert.deepEqual(await fs.readFile(untouched.payload), trashBytes);
  assert.deepEqual(await fs.readFile(untouched.infoPath), untouchedInfo);
  assert.equal(await exists(untouched.original), false);
  assert.equal(report.nativeTrashCalls, 6);
  assert.equal(allowedPath, null);
  report.checks.push('All six native Trash calls were explicitly authorized fixture paths; the unselected source and separate private Trash sentinel remain intact. No Trash-wide empty command ran.');
}

const watchdog = setTimeout(() => finish(new Error('Private storage acceptance timed out.')), 90000);
let finishing = false;
async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  if (error) report.errors.push(String(error.stack || error));
  report.result = error ? 'failed' : 'passed';
  await fs.writeFile(path.join(base, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  app.exit(error ? 1 : 0);
}
app.whenReady().then(main).then(() => finish(), finish);
