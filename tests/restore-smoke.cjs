'use strict';

// Linux-only native restoration in the private bus and Trash prepared by the
// runner. Production exposes no restore/empty bypass or restoration API.
const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const runFile = promisify(execFile);
const base = process.env.DISKHARBOR_RESTORE_DIR;
assert.equal(process.platform, 'linux');
assert.ok(base && path.isAbsolute(base) && path.basename(base).startsWith('restore-smoke-'));
const root = path.join(base, 'files');
const userData = path.join(base, 'user-data');
const trashRoot = path.join(process.env.XDG_DATA_HOME, 'Trash');
assert.ok(path.resolve(trashRoot).startsWith(`${base}${path.sep}`));
const report = { platform: process.platform, checks: [], errors: [], restorations: [], boundary: 'Linux GIO command-line restoration, not file-manager GUI or Windows/macOS restoration.' };
const nativeTrash = shell.trashItem;
const nativeDialog = dialog.showMessageBox;
const authorized = new Set();
let nativeCalls = 0;
let window;
let finishing = false;
const watchdog = setTimeout(() => finish(new Error('Isolated restoration test timed out.')), 90000);
app.setPath('userData', userData);
app.setPath('sessionData', path.join(userData, 'session'));
app.commandLine.appendSwitch('disable-gpu');

async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  shell.trashItem = nativeTrash;
  dialog.showMessageBox = nativeDialog;
  report.result = error ? 'failed' : report.unicodeDiagnostic?.status === 'known-cli-limitation' ? 'passed-with-limitations' : 'passed';
  if (error) report.error = String(error.stack || error);
  report.nativeTrashCalls = nativeCalls;
  await fs.writeFile(path.join(base, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(error ? 1 : 0);
}
function call(method, ...args) {
  return window.webContents.executeJavaScript(`window.diskharbor[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
// GIO formats byte-string attributes as printable ASCII plus \xhh escapes,
// including non-ASCII UTF-8 bytes and backslashes. Compare its entire value.
function gioByteString(value) {
  return [...Buffer.from(value, 'utf8')].map(byte => byte >= 32 && byte <= 126 && byte !== 92
    ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`).join('');
}
async function exists(target) { return fs.lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }); }
async function gio(args) {
  assert.ok(!args.includes('--force') && !args.includes('-f') && !args.includes('--empty'));
  try {
    const result = await runFile('gio', args, { timeout: 10000, maxBuffer: 65536, shell: false, env: { ...process.env, LC_ALL: 'C.UTF-8' } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error.killed || error.signal || typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}
async function scan() {
  await call('startScan', root);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const summary = await call('summary');
    if (summary?.state === 'completed') return summary;
    if (summary?.state === 'error') throw new Error(summary.message || 'Scan failed');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Fixture scan did not finish.');
}
async function trashEntry(originalPath) {
  // Only enumerate the test-owned on-disk info directory, never trash:///.
  const names = await fs.readdir(path.join(trashRoot, 'info'));
  const matches = [];
  for (const name of names) {
    if (!name.endsWith('.trashinfo')) continue;
    const infoPath = path.join(trashRoot, 'info', name);
    const text = await fs.readFile(infoPath, 'utf8');
    const encoded = text.match(/^Path=(.*)$/m)?.[1];
    if (encoded && decodeURIComponent(encoded) === originalPath) {
      assert.match(text, /^\[Trash Info\]/);
      assert.match(text, /^DeletionDate=\d{4}-\d{2}-\d{2}T/m);
      const nameInTrash = name.slice(0, -'.trashinfo'.length);
      matches.push({ originalPath, infoPath, payload: path.join(trashRoot, 'files', nameInTrash), uri: `trash:///${encodeURIComponent(nameInTrash)}` });
    }
  }
  assert.equal(matches.length, 1, `Exactly one owned Trash entry must match ${originalPath}`);
  const entry = matches[0];
  assert.equal(await exists(entry.payload), true);
  // Independently ask the private backend for this exact URI's original path.
  const deadline = Date.now() + 5000;
  let lastInfo;
  while (Date.now() < deadline) {
    const info = await gio(['info', '-a', 'trash::orig-path', entry.uri]);
    lastInfo = info;
    const prefix = '  trash::orig-path: ';
    const paths = info.stdout.split('\n').filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length));
    if (info.code === 0 && paths.length === 1 && paths[0] === gioByteString(originalPath)) return entry;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Private GIO backend did not confirm the owned original path: ${entry.uri}\n${JSON.stringify(lastInfo)}`);
}
async function removeThroughApp(target) {
  assert.ok(target.startsWith(`${root}${path.sep}`));
  await scan();
  const entries = (await call('query', { limit: 1000 })).entries;
  const entry = entries.find(item => item.path === target);
  assert.ok(entry, target);
  const plan = await call('planCleanup', [entry.id]);
  assert.equal(plan.items[0].eligible, true, JSON.stringify(plan));
  authorized.add(target);
  const result = await call('executeCleanup', plan.id, 'en');
  assert.equal(result.success, 1, JSON.stringify(result));
  assert.equal(result.items[0].status, 'trashed');
  assert.equal(await exists(target), false);
  return { entry: await trashEntry(target), record: result };
}
async function restore(entry) {
  assert.ok(entry.originalPath.startsWith(`${root}${path.sep}`));
  assert.ok(entry.payload.startsWith(`${trashRoot}${path.sep}files${path.sep}`));
  assert.equal(await exists(entry.payload), true);
  return gio(['trash', '--restore', entry.uri]);
}
async function assertRestored(entry) {
  assert.equal(await exists(entry.originalPath), true);
  assert.equal(await exists(entry.payload), false);
  assert.equal(await exists(entry.infoPath), false);
}
async function checkUnchangedHistory(history, bytes) {
  assert.deepEqual(await call('history'), history);
  assert.deepEqual(await fs.readFile(path.join(userData, 'operation-history.json')), bytes);
}
async function execute() {
  // Older GIO versions treat display-escaped original paths as real paths.
  // Keep that diagnostic's possible destination wholly inside this fixture.
  assert.equal(gioByteString(root), root, 'The restoration fixture parent must be an unescaped ASCII path.');
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  assert.equal(window.webContents.getLastWebPreferences().nodeIntegration, false);
  assert.match(window.webContents.getURL(), /^diskharbor:\/\/app\//);
  report.gioVersion = (await gio(['version'])).stdout.trim();
  // This sentinel stays in the isolated Trash across every restoration.
  const untouchedTrashPath = path.join(root, 'leave-in-trash.txt');
  const untouchedTrashBytes = Buffer.from('Test-owned unrelated Trash sentinel.\n');
  await fs.writeFile(untouchedTrashPath, untouchedTrashBytes);
  const untouchedTrash = await removeThroughApp(untouchedTrashPath);
  const untouchedInfo = await fs.readFile(untouchedTrash.entry.infoPath);
  const ordinarySentinel = path.join(root, 'never-selected.txt');
  const ordinaryBytes = Buffer.from('Test-owned file that must never be selected.\n');
  await fs.writeFile(ordinarySentinel, ordinaryBytes);
  report.checks.push('The real application uses sandboxed production IPC and native Trash inside a verified private GIO session; each URI is matched to its owned original path.');

  const filePath = path.join(root, 'special % # + file.bin');
  const originalBytes = Buffer.from([0, 1, 2, 127, 128, 255, 10, 13, 32]);
  await fs.writeFile(filePath, originalBytes);
  const file = await removeThroughApp(filePath);
  assert.deepEqual(await fs.readFile(file.entry.payload), originalBytes);
  const history = await call('history');
  const historyBytes = await fs.readFile(path.join(userData, 'operation-history.json'));
  const summary = await call('summary');
  assert.equal((await restore(file.entry)).code, 0);
  await assertRestored(file.entry);
  assert.deepEqual(await fs.readFile(filePath), originalBytes);
  await checkUnchangedHistory(history, historyBytes);
  assert.deepEqual(await call('summary'), summary);
  await scan();
  assert.ok((await call('query', { kind: 'file', limit: 1000 })).entries.some(item => item.path === filePath));
  await checkUnchangedHistory(history, historyBytes);
  report.restorations.push({ scenario: 'ascii-punctuation-and-rescan', sha256: hash(originalBytes), recordId: file.record.id });
  report.checks.push('GIO restores exact binary contents for an ASCII filename containing spaces/percent/hash/plus; external restoration leaves the activity and old scan unchanged until an explicit rescan.');

  const directory = path.join(root, 'folder # %');
  await fs.mkdir(path.join(directory, 'nested', 'empty'), { recursive: true });
  await fs.writeFile(path.join(directory, 'top.txt'), 'directory top sentinel\n');
  await fs.writeFile(path.join(directory, 'nested', 'data.bin'), originalBytes);
  const folder = await removeThroughApp(directory);
  assert.equal((await restore(folder.entry)).code, 0);
  await assertRestored(folder.entry);
  assert.equal(await fs.readFile(path.join(directory, 'top.txt'), 'utf8'), 'directory top sentinel\n');
  assert.deepEqual(await fs.readFile(path.join(directory, 'nested', 'data.bin')), originalBytes);
  assert.equal((await fs.stat(path.join(directory, 'nested', 'empty'))).isDirectory(), true);
  report.checks.push('A native directory Trash operation can be restored through GIO with nested bytes and an empty directory intact.');

  const conflictPath = path.join(root, 'conflict.txt');
  await fs.writeFile(conflictPath, 'original version\n');
  const conflict = await removeThroughApp(conflictPath);
  await fs.writeFile(conflictPath, 'new version at the original path\n');
  const refused = await restore(conflict.entry);
  assert.notEqual(refused.code, 0);
  assert.equal(await fs.readFile(conflictPath, 'utf8'), 'new version at the original path\n');
  assert.equal(await fs.readFile(conflict.entry.payload, 'utf8'), 'original version\n');
  assert.equal(await exists(conflict.entry.infoPath), true);
  const preservedNew = path.join(root, 'conflict-new-copy.txt');
  await fs.rename(conflictPath, preservedNew);
  assert.equal((await restore(conflict.entry)).code, 0);
  await assertRestored(conflict.entry);
  assert.equal(await fs.readFile(conflictPath, 'utf8'), 'original version\n');
  assert.equal(await fs.readFile(preservedNew, 'utf8'), 'new version at the original path\n');
  report.restorations.push({ scenario: 'same-name-conflict', refusedCode: refused.code, bothCopiesPreserved: true });
  report.checks.push('Default GIO restoration refuses a same-name file conflict without overwriting either copy; moving aside only the test-created new copy permits safe restoration.');

  const parent = path.join(root, 'missing-parent', 'nested');
  await fs.mkdir(parent, { recursive: true });
  const missingParentFile = path.join(parent, 'restore.txt');
  await fs.writeFile(missingParentFile, 'missing parent sentinel\n');
  const missingParent = await removeThroughApp(missingParentFile);
  await fs.rmdir(parent);
  await fs.rmdir(path.dirname(parent));
  assert.equal((await restore(missingParent.entry)).code, 0);
  await assertRestored(missingParent.entry);
  assert.equal(await fs.readFile(missingParentFile, 'utf8'), 'missing parent sentinel\n');
  report.checks.push('This Linux GIO environment recreates missing parent directories when restoring its owned file; this is not a promise about other systems or unavailable volumes.');

  const secondAttempt = await gio(['trash', '--restore', missingParent.entry.uri]);
  assert.notEqual(secondAttempt.code, 0);
  assert.equal(await fs.readFile(missingParentFile, 'utf8'), 'missing parent sentinel\n');
  assert.deepEqual(await fs.readFile(ordinarySentinel), ordinaryBytes);
  assert.deepEqual(await fs.readFile(untouchedTrash.entry.payload), untouchedTrashBytes);
  assert.deepEqual(await fs.readFile(untouchedTrash.entry.infoPath), untouchedInfo);
  assert.equal(await exists(untouchedTrashPath), false);
  report.checks.push('Repeating restoration of an already-restored URI fails harmlessly; the restored file, an unselected file and a separate owned Trash item remain unchanged.');
  // A separate diagnostic, never counted as a successful restoration check
  // when an older system CLI restores the bytes under an incorrect name.
  const unicodePath = path.join(root, '照片 % # + 文件.bin');
  const escapedPath = gioByteString(unicodePath);
  assert.equal(path.dirname(escapedPath), root);
  assert.equal(await exists(escapedPath), false);
  await fs.writeFile(unicodePath, originalBytes);
  const unicode = await removeThroughApp(unicodePath);
  const unicodeHistory = await call('history');
  const unicodeHistoryBytes = await fs.readFile(path.join(userData, 'operation-history.json'));
  const unicodeRestore = await restore(unicode.entry);
  assert.equal(unicodeRestore.code, 0);
  if (await exists(unicodePath)) {
    await assertRestored(unicode.entry);
    assert.deepEqual(await fs.readFile(unicodePath), originalBytes);
    assert.equal(await exists(escapedPath), false);
    report.unicodeDiagnostic = { status: 'verified', originalPath: unicodePath, sha256: hash(originalBytes), returnedCode: 0 };
  } else {
    assert.equal(await exists(unicode.entry.payload), false);
    assert.equal(await exists(unicode.entry.infoPath), false);
    assert.deepEqual(await fs.readFile(escapedPath), originalBytes);
    report.unicodeDiagnostic = { status: 'known-cli-limitation', originalPath: unicodePath, actualPath: escapedPath,
      sha256: hash(originalBytes), returnedCode: 0, originalNameRestored: false,
      explanation: 'The system GIO CLI used its display-escaped original path as the restoration target. Exit 0 did not mean the original name was restored. This case is not counted among passed restoration checks.',
      source: 'https://github.com/GNOME/glib/blob/2.72.4/gio/gio-tool-trash.c#L103' };
  }
  await checkUnchangedHistory(unicodeHistory, unicodeHistoryBytes);
  assert.deepEqual(await fs.readFile(ordinarySentinel), ordinaryBytes);
  assert.deepEqual(await fs.readFile(untouchedTrash.entry.payload), untouchedTrashBytes);
  assert.deepEqual(await fs.readFile(untouchedTrash.entry.infoPath), untouchedInfo);
  assert.equal(nativeCalls, 6);
  assert.equal(authorized.size, 0);
  assert.deepEqual(report.errors, []);
}

try {
  fsSync.mkdirSync(root, { recursive: true });
  fsSync.mkdirSync(userData, { recursive: true });
  dialog.showMessageBox = async () => ({ response: 1 });
  shell.trashItem = async target => {
    assert.ok(authorized.delete(target), `Unauthorized native target: ${target}`);
    nativeCalls++;
    return nativeTrash(target);
  };
  app.on('browser-window-created', (_event, created) => {
    if (window) return;
    window = created;
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
    window.webContents.once('did-finish-load', () => execute().then(() => finish(), finish));
  });
  require('../electron/main.cjs');
} catch (error) { finish(error); }
