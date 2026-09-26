'use strict';

// Run through `npm run test:desktop`, after building the renderer. Only this
// disposable harness controls confirmation. Production has no bypass switch.
const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const base = process.env.DISKHARBOR_SMOKE_DIR;
assert.ok(base && path.isAbsolute(base) && path.basename(base).startsWith('native-smoke-'));
const root = path.join(base, 'files');
const userData = path.join(base, 'user-data');
const report = { platform: process.platform, checks: [], errors: [] };
let window;
let finishing = false;
let originalTrash;
let originalDialog;
app.setPath('userData', userData);
app.setPath('sessionData', path.join(userData, 'session'));
app.commandLine.appendSwitch('disable-gpu');
const watchdog = setTimeout(() => finish(new Error('Desktop smoke test timed out.')), 60000);

async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  if (originalTrash) shell.trashItem = originalTrash;
  if (originalDialog) dialog.showMessageBox = originalDialog;
  report.result = error ? 'failed' : 'passed';
  if (error) report.error = String(error.stack || error);
  await fs.writeFile(path.join(base, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(error ? 1 : 0);
}
function call(method, ...args) {
  return window.webContents.executeJavaScript(`window.diskharbor[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
}
function render(read, ...args) {
  return window.webContents.executeJavaScript(`(${read.toString()})(...${JSON.stringify(args)})`);
}
async function waitForUI(description, read, ...args) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await render(read, ...args);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Renderer did not become ready: ${description}`);
}
async function clickButton(labels, selector = 'button') {
  await waitForUI(`enabled button ${labels.join(' / ')}`, (names, scope) => {
    const button = [...document.querySelectorAll(scope)].find(node => names.includes(node.textContent.trim()));
    if (!button || button.disabled || !button.getClientRects().length) return false;
    button.click();
    return true;
  }, labels, selector);
}
// Read public DOM semantics rather than React internals or test-only app hooks.
function cleanupUI() {
  const findButton = (names, scope = document) => [...scope.querySelectorAll('button')].find(node => names.includes(node.textContent.trim()));
  const describe = node => node ? { disabled: node.disabled, text: node.textContent.trim() } : null;
  const panel = document.querySelector('section[aria-label="Cleanup progress"], section[aria-label="整理进度"]');
  const meter = panel?.querySelector('progress');
  const scan = document.querySelector('section[aria-label="Scan location"], section[aria-label="扫描位置"]');
  const pathInput = scan?.querySelector('input');
  return {
    page: document.querySelector('nav button[aria-current="page"]')?.textContent.trim(),
    panel: panel ? {
      text: panel.textContent,
      title: panel.querySelector('[role="status"]')?.textContent,
      value: meter?.value, max: meter?.max,
      cancel: describe(findButton(['Cancel remaining', '取消剩余操作', 'Stopping…', '正在请求停止…'], panel)),
    } : null,
    scan: scan ? {
      button: describe(findButton(['Scan again', '重新扫描', 'Start scan', '开始扫描'], scan)),
      browse: describe(findButton(['Browse', '选择文件夹'], scan)),
      path: pathInput?.value, pathDisabled: pathInput?.disabled,
    } : null,
    clear: describe(findButton(['Clear activity', '清除记录'])),
    rescan: describe(findButton(['Update scan', '更新扫描'])),
  };
}
async function scan() {
  await call('startScan', root);
  for (let i = 0; i < 200; i++) {
    const summary = await call('summary');
    if (summary?.state === 'completed') return summary;
    if (summary?.state === 'error') throw new Error(summary.message || 'Scan failed.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Scan did not complete.');
}
async function exists(file) { return fs.lstat(file).then(() => true, () => false); }
async function execute() {
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(app.commandLine.hasSwitch('no-sandbox'), false);
  assert.match(window.webContents.getURL(), /^diskharbor:\/\/app\//);
  assert.equal(await call('summary'), null);
  report.checks.push('Production protocol, sandbox and no initial scan.');

  const recovered = await call('history');
  assert.equal(recovered[0].state, 'interrupted');
  assert.equal(recovered[0].items[0].status, 'unknown');
  assert.equal(recovered[0].items[1].status, 'cancelled');
  report.checks.push('Interrupted processing recovered as uncertain; pending item cancelled.');
  await call('clearHistory');

  report.scan = await scan();
  const entries = (await call('query', { limit: 100 })).entries;
  const find = name => {
    const entry = entries.find(item => item.name === name);
    assert.ok(entry, `Missing scanned entry: ${name}`);
    return entry;
  };
  originalDialog = dialog.showMessageBox;
  let accept = false;
  let lastDialog;
  dialog.showMessageBox = async (_parent, options) => { lastDialog = options; return { response: accept ? 1 : 0 }; };
  const cancelled = await call('planCleanup', [find('first.txt').id]);
  const cancelResult = await call('executeCleanup', cancelled.id, 'en');
  assert.equal(cancelResult.items[0].status, 'cancelled');
  assert.equal(await exists(path.join(root, 'first.txt')), true);
  assert.equal(lastDialog.buttons[0], 'Cancel');
  report.checks.push('Localized native confirmation cancellation preserves original.');

  const folderPlan = await call('planCleanup', [find('sample-folder').id, find('nested.txt').id]);
  assert.equal(folderPlan.items.length, 1);
  assert.equal(folderPlan.omittedCount, 1);
  assert.equal(folderPlan.items[0].kind, 'directory');
  assert.equal(folderPlan.items[0].eligible, true, JSON.stringify(folderPlan));
  await fs.writeFile(path.join(root, 'sample-folder', 'new.txt'), 'Appeared after preview.');
  accept = true;
  const changed = await call('executeCleanup', folderPlan.id, 'zh-CN');
  assert.equal(changed.success, 0);
  assert.equal(changed.failed, 1);
  assert.equal(await exists(path.join(root, 'sample-folder', 'new.txt')), true);
  assert.equal(lastDialog.buttons[0], '取消');
  report.checks.push('Parent/child normalized; post-preview directory change refused.');

  await scan();
  const folder = (await call('query', { search: 'sample-folder', kind: 'directory' })).entries.find(item => item.name === 'sample-folder');
  const current = await call('planCleanup', [folder.id]);
  assert.equal(current.items[0].eligible, true, JSON.stringify(current));
  const moved = await call('executeCleanup', current.id, 'en');
  assert.equal(moved.success, 1, JSON.stringify(moved));
  assert.equal(await exists(path.join(root, 'sample-folder')), false);
  report.checks.push('Real native directory Trash operation succeeds.');
  if (process.platform === 'linux') {
    const trashRoot = path.join(process.env.XDG_DATA_HOME, 'Trash');
    const names = await fs.readdir(path.join(trashRoot, 'files'));
    const name = names.find(name => name.startsWith('sample-folder'));
    assert.ok(name);
    assert.equal(await fs.readFile(path.join(trashRoot, 'files', name, 'nested', 'nested.txt'), 'utf8'), 'Nested smoke fixture.');
    const metadata = await fs.readFile(path.join(trashRoot, 'info', `${name}.trashinfo`), 'utf8');
    assert.ok(decodeURIComponent(metadata).includes(path.join(root, 'sample-folder')));
    report.checks.push('Isolated Linux Trash contents and original-path metadata match.');
  }

  // Start the final scan through the UI so its path is populated, and an earlier
  // operation's rescan requirement cannot make the following assertions pass.
  await clickButton(['Overview', '空间概览'], 'nav button');
  await waitForUI('previous cleanup result applied', () => {
    const button = [...document.querySelectorAll('button')].find(node => ['Update scan', '更新扫描'].includes(node.textContent.trim()));
    return button && !button.disabled;
  });
  const previousScan = await call('summary');
  await render(target => {
    const input = document.querySelector('input[aria-label="Scan path"], input[aria-label="扫描路径"]');
    if (!input) throw new Error('Scan path input is missing.');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, target);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, root);
  await clickButton(['Scan again', '重新扫描']);
  await waitForUI('fresh completed UI scan', async oldId => {
    let summary;
    try { summary = await window.diskharbor.summary(); }
    catch (error) {
      // UI-triggered scans replace the worker asynchronously. Retry only these
      // transition codes within waitForUI's existing five-second deadline.
      if (/(?:^|:\s*)(?:SCAN_REPLACED|NO_SCAN)$/.test(String(error?.message || error))) return false;
      throw error;
    }
    return summary?.state === 'completed' && summary.scanId !== oldId;
  }, previousScan.scanId);
  await waitForUI('scan controls unlocked after fresh scan', () => {
    const button = [...document.querySelectorAll('button')].find(node => ['Scan again', '重新扫描'].includes(node.textContent.trim()));
    return button && !button.disabled;
  });
  const beforeBatch = await render(cleanupUI);
  assert.equal(beforeBatch.scan.path, root);
  assert.equal(beforeBatch.scan.pathDisabled, false);
  assert.equal(beforeBatch.scan.browse.disabled, false);
  assert.equal(beforeBatch.rescan, null);
  const remaining = (await call('query', { kind: 'file' })).entries;
  const batch = await call('planCleanup', remaining.map(entry => entry.id));
  assert.equal(batch.items.length, 2);
  originalTrash = shell.trashItem;
  let calls = 0;
  let uiFailure;
  shell.trashItem = async item => {
    assert.ok(item.startsWith(`${root}${path.sep}`), 'Test may only act on its own fixture.');
    calls++;
    try {
      // Hold only this disposable native call until real IPC progress reaches the
      // renderer. No artificial progress or fixed long sleep is involved.
      await waitForUI('active cleanup panel with current fixture path', currentPath => {
        const panel = document.querySelector('section[aria-label="Cleanup progress"], section[aria-label="整理进度"]');
        return panel?.textContent.includes(currentPath) && panel.querySelector('progress')?.max === 2;
      }, item);
      const running = await render(cleanupUI);
      assert.equal(running.panel.value, 0);
      assert.equal(running.panel.cancel.disabled, false);
      assert.equal(running.scan.button.disabled, true);
      assert.equal(running.scan.browse.disabled, true);
      assert.equal(running.scan.pathDisabled, true);
      report.checks.push('Real cleanup panel shows current native item and locks new scanning.');

      await clickButton(['Activity', '操作记录'], 'nav button');
      await waitForUI('activity page with locked clear action', () => {
        const button = [...document.querySelectorAll('button')].find(node => ['Clear activity', '清除记录'].includes(node.textContent.trim()));
        return button?.disabled;
      });
      const activity = await render(cleanupUI);
      assert.ok(['Activity', '操作记录'].includes(activity.page));
      assert.equal(activity.panel.value, 0);
      assert.equal(activity.panel.max, 2);
      assert.ok(activity.panel.text.includes(item));
      assert.equal(activity.clear.disabled, true);
      report.checks.push('Page navigation preserves live progress and activity clearing is locked.');

      await clickButton(['Cancel remaining', '取消剩余操作'], 'section[aria-label] button');
      await waitForUI('cancellation acknowledged by backend and renderer', async () => {
        const status = await window.diskharbor.cleanupStatus();
        const panel = document.querySelector('section[aria-label="Cleanup progress"], section[aria-label="整理进度"]');
        const button = [...(panel?.querySelectorAll('button') || [])].find(node => ['Stopping…', '正在请求停止…'].includes(node.textContent.trim()));
        return status?.state === 'cancelling' && button?.disabled;
      });
      assert.equal(await exists(item), true, 'Cancellation must not pretend the in-flight native item was already moved.');
    } catch (error) {
      uiFailure = error;
      throw error;
    }
    return originalTrash(item);
  };
  let partial;
  try { partial = await call('executeCleanup', batch.id, 'en'); }
  finally { shell.trashItem = originalTrash; }
  if (uiFailure) throw uiFailure;
  assert.equal(calls, 1);
  assert.equal(partial.success, 1);
  assert.equal(partial.items.filter(item => item.status === 'cancelled').length, 1);
  assert.equal(partial.state, 'cancelled');
  for (const item of partial.items) assert.equal(await exists(item.path), item.status === 'cancelled');
  const status = await call('cleanupStatus');
  assert.equal(status.state, 'cancelled');
  assert.equal(status.processed, status.total);
  report.checks.push('Cancellation finishes current native item and preserves the remainder.');
  await waitForUI('completed counts and mandatory rescan in renderer', () => {
    const panel = document.querySelector('section[aria-label="Cleanup progress"], section[aria-label="整理进度"]');
    const rescan = [...document.querySelectorAll('button')].find(node => ['Update scan', '更新扫描'].includes(node.textContent.trim()));
    return panel?.querySelector('progress')?.value === 2 && rescan && !rescan.disabled;
  });
  const finished = await render(cleanupUI);
  assert.ok(['Remaining operations stopped', '已停止剩余操作'].includes(finished.panel.title));
  assert.match(finished.panel.text, /(?:Trashed|已回收)\s*1/);
  assert.match(finished.panel.text, /(?:Cancelled|取消)\s*1/);
  assert.match(finished.panel.text, /(?:Failed|失败)\s*0/);
  assert.equal(finished.panel.cancel, null);
  assert.equal(finished.clear.disabled, false);
  await clickButton(['File tree', '文件树'], 'nav button');
  await waitForUI('selection locked until rescan', () => {
    const checkboxes = [...document.querySelectorAll('[role="treegrid"] input[type="checkbox"]')];
    return checkboxes.length === 2 && checkboxes.every(node => node.disabled);
  });
  assert.ok((await render(cleanupUI)).rescan, 'The rescan requirement must persist across pages.');
  report.checks.push('UI cancellation reports 1 trashed and 1 cancelled; further selection requires rescan.');
  const history = await call('history');
  assert.equal(history.length, 4);
  assert.equal(history.some(item => item.state === 'running'), false);
  const saved = JSON.parse(await fs.readFile(path.join(userData, 'operation-history.json'), 'utf8'));
  assert.equal(saved.length, 4);
  report.checks.push('Final operation journals persist without duplicate progress records.');
  assert.deepEqual(report.errors, []);
}

try {
  fsSync.mkdirSync(path.join(root, 'sample-folder', 'nested'), { recursive: true });
  fsSync.mkdirSync(userData, { recursive: true });
  fsSync.mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
  fsSync.writeFileSync(path.join(root, 'sample-folder', 'nested', 'nested.txt'), 'Nested smoke fixture.');
  fsSync.writeFileSync(path.join(root, 'first.txt'), 'First smoke fixture.');
  fsSync.writeFileSync(path.join(root, 'second.txt'), 'Second smoke fixture.');
  fsSync.writeFileSync(path.join(userData, 'operation-history.json'), JSON.stringify([{
    id: 'interrupted-fixture', planId: 'old-plan', time: Date.now(), rootPath: root,
    state: 'running', success: 0, failed: 0, freeSpaceDelta: null,
    items: [{ path: path.join(root, 'first.txt'), status: 'processing' }, { path: path.join(root, 'second.txt'), status: 'pending' }],
  }]));
  app.on('browser-window-created', (_event, created) => {
    if (window) return;
    window = created;
    window.webContents.on('console-message', (_event, details) => {
      if (details.level === 'error') report.errors.push(details.message);
    });
    window.webContents.once('did-finish-load', () => execute().then(() => finish(), finish));
  });
  require('../electron/main.cjs');
} catch (error) { void finish(error); }
