'use strict';

// Only the home/cache roots are redirected. The scanner, IPC, preload and UI
// are production code; no filesystem responses or renderer timings are mocked.
const { app, clipboard, shell } = require('electron');
const assert = require('node:assert/strict');
const { dialog } = require('electron');
const permissionDialog = dialog.showMessageBox;
dialog.showMessageBox = async (_owner, options) => {
  assert.ok(['扫描权限', 'Scan access'].includes(options.title), 'Only the fixture scan-access prompt may be handled here.');
  return { response: 1 }; // Direct scan; this is not interactive TCC acceptance.
};

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const base = process.env.DISKHARBOR_CACHE_SMOKE_DIR;
assert.ok(base && path.isAbsolute(base) && path.basename(base).startsWith('cache-smoke-'));
const fixtureHome = path.join(base, 'home');
const userData = path.join(base, 'user-data');
const emptyScope = path.join(fixtureHome, 'empty-scope');
const cacheBase = process.platform === 'win32'
  ? path.join(fixtureHome, 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  : process.platform === 'darwin'
    ? path.join(fixtureHome, 'Library', 'Caches', 'Google', 'Chrome')
    : path.join(fixtureHome, '.cache', 'google-chrome');
const cacheDirectory = path.join(cacheBase, 'Default', 'Cache');
const cacheData = path.join(cacheDirectory, 'Cache_Data');
const fakeDirectory = path.join(fixtureHome, 'documents', 'google-chrome', 'Default', 'Cache', 'Cache_Data');
const settingsAddress = 'chrome://settings/clearBrowserData';
const report = { platform: process.platform, checks: [], errors: [] };
const originalGetPath = app.getPath;
const originalTrash = shell.trashItem;
let originalClipboard;
let trashCalls = 0;
let window;
let finishing = false;

app.getPath = function (name) {
  return name === 'home' ? fixtureHome : originalGetPath.call(this, name);
};
// A guide has no reason to trash anything. Fail closed if that boundary regresses.
shell.trashItem = async function () {
  trashCalls += 1;
  throw new Error('A cache guide must never call the system Trash API.');
};
app.setPath('userData', userData);
app.setPath('sessionData', path.join(userData, 'session'));
app.commandLine.appendSwitch('disable-gpu');
const watchdog = setTimeout(() => finish(new Error('Cache desktop smoke timed out.')), 90000);

async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  app.getPath = originalGetPath;
  dialog.showMessageBox = permissionDialog;
  shell.trashItem = originalTrash;
  if (originalClipboard !== undefined) {
    try { await clipboard.writeText(originalClipboard); }
    catch (restoreError) { error ||= restoreError; }
  }
  report.result = error ? 'failed' : 'passed';
  if (error) {
    report.error = String(error.stack || error);
    if (window && !window.isDestroyed()) {
      report.ui = await render(() => ({
        page: document.querySelector('nav button[aria-current="page"]')?.textContent.trim(),
        cache: document.querySelector('section[aria-label="Browser cache"], section[aria-label="浏览器缓存"]')?.textContent,
        alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent),
      })).catch(() => null);
    }
  }
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
async function waitFor(description, read, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Cache smoke wait failed: ${description}`);
}
function waitForUI(description, read, ...args) {
  return waitFor(description, () => render(read, ...args));
}
async function clickButton(labels, selector = 'button') {
  await waitForUI(`button ${labels.join(' / ')}`, (names, scope) => {
    const button = [...document.querySelectorAll(scope)].find(node => names.includes(node.textContent.trim())
      || [...node.querySelectorAll(':scope > span')].some(span => names.includes(span.textContent.trim())));
    if (!button || button.disabled || !button.getClientRects().length) return false;
    button.focus({ preventScroll: true });
    button.click();
    return true;
  }, labels, selector);
}
async function startThroughUI(target) {
  const previous = await call('summary');
  await waitForUI('editable scan location', value => {
    const input = document.querySelector('input[aria-label="Scan path"], input[aria-label="扫描路径"]');
    if (!input || input.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, target);
  await clickButton(['Start scan', '开始扫描', 'Scan again', '重新扫描'], 'section[aria-label="Scan location"] button, section[aria-label="扫描位置"] button');
  return waitFor('new completed scan', async () => {
    let value;
    try { value = await call('summary'); }
    catch (error) {
      if (/(?:^|:\s*)(?:SCAN_REPLACED|NO_SCAN)$/.test(String(error?.message || error))) return false;
      throw error;
    }
    if (value?.state === 'error') throw new Error(value.message || 'Scan failed.');
    return value?.state === 'completed' && value.scanId !== previous?.scanId ? value : false;
  });
}
function cacheUI() {
  const section = document.querySelector('section[aria-label="Browser cache"], section[aria-label="浏览器缓存"]');
  if (!section) return null;
  return {
    text: section.textContent,
    cards: [...section.querySelectorAll('article')].map(article => ({
      name: article.getAttribute('aria-label'), text: article.textContent,
      paths: [...article.querySelectorAll('[title]')].map(node => node.title),
      measures: [...article.querySelectorAll('dl > div')].map(node => ({
        label: node.querySelector('dt')?.textContent.trim(),
        value: node.querySelector('dd')?.textContent.trim(),
      })),
      checkboxes: article.querySelectorAll('input[type="checkbox"]').length,
      buttons: [...article.querySelectorAll('button')].map(node => node.textContent.trim()),
    })),
    loading: [...section.querySelectorAll('[role="status"]')].some(node => /正在识别|Checking scanned/.test(node.textContent)),
  };
}
async function currentCard() {
  return waitFor('cache card for current indexed directory', async () => {
    const ui = await render(cacheUI);
    return ui && !ui.loading && ui.cards.find(card => card.paths.includes(cacheDirectory));
  });
}

async function execute() {
  originalClipboard = await clipboard.readText();
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(app.commandLine.hasSwitch('no-sandbox'), false);
  assert.match(window.webContents.getURL(), /^diskharbor:\/\/app\//);
  assert.equal((await call('info')).home, fixtureHome);
  assert.equal(await call('summary'), null);
  await assert.rejects(call('cacheReport', 'no-current-scan'), /NO_SCAN/);
  assert.deepEqual(await call('history'), []);
  report.checks.push('Production sandbox starts with an isolated synthetic home and no automatic scan.');

  const first = await startThroughUI(fixtureHome);
  const result = await call('cacheReport', first.scanId);
  assert.equal(result.scanId, first.scanId);
  assert.equal(result.rootPath, fixtureHome);
  assert.equal(result.scanState, 'completed');
  assert.equal(result.truncated, false);
  assert.equal(result.findings.length, 1, 'A lookalike path outside trusted browser roots must not match.');
  const finding = result.findings[0];
  assert.equal(finding.ruleId, `chrome-http-cache-${process.platform}`);
  assert.equal(finding.profile, 'Default');
  assert.equal(finding.complete, true);
  assert.equal(finding.entry.path, cacheDirectory);
  assert.deepEqual(finding.entry, await call('entry', finding.entry.id));
  assert.equal(finding.entry.logicalSize, 137000 + 31);
  assert.equal(finding.entry.fileCount, 2);
  assert.ok(result.rules.some(rule => rule.id === finding.ruleId));
  report.scan = { scanId: result.scanId, rootPath: result.rootPath, ruleSetVersion: result.ruleSetVersion };
  report.cache = { path: finding.entry.path, logicalSize: finding.entry.logicalSize, allocatedSize: finding.entry.allocatedSize, files: finding.entry.fileCount };
  report.checks.push('A real scan returns only the anchored Chrome cache with current indexed identity and measured bytes.');

  await assert.rejects(call('cacheReport', { scanId: first.scanId, rootPath: fakeDirectory, findings: [{ entry: { id: finding.entry.id, allocatedSize: 999999999 } }] }), /SCAN_CHANGED/);
  assert.deepEqual((await call('cacheReport', first.scanId)).findings, result.findings);
  await clipboard.writeText('cache-smoke-unchanged');
  await assert.rejects(call('copyCacheSettings', 'untrusted-rule'), /INVALID_CACHE_RULE/);
  await assert.rejects(call('copyCacheSettings', { id: finding.ruleId, url: 'https://invalid.example/' }), /INVALID_CACHE_RULE/);
  assert.equal(await clipboard.readText(), 'cache-smoke-unchanged');
  report.checks.push('Renderer-supplied report objects and arbitrary guide identifiers are refused without changing findings or clipboard.');

  await clickButton(['Make room', '整理空间'], 'nav button');
  const card = await currentCard();
  assert.equal(card.checkboxes, 0, 'Cache guidance must not introduce a cleanup selection.');
  assert.match(card.text, /Default/);
  const measure = labels => card.measures.find(item => labels.includes(item.label))?.value;
  assert.equal(measure(['文件内容大小', 'Logical size']), '133.8 KiB');
  assert.equal(measure(['已记录文件', 'Recorded files']), '2');
  const allocated = finding.entry.allocatedSize;
  const allocatedDisplay = measure(['已记录的磁盘占用', 'Recorded space on disk']);
  if (allocated === null) assert.match(allocatedDisplay, /^(?:未知|Unknown)$/);
  else {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const exponent = allocated > 0 ? Math.min(4, Math.floor(Math.log(allocated) / Math.log(1024))) : 0;
    assert.equal(allocatedDisplay, `${new Intl.NumberFormat('en', { maximumFractionDigits: exponent ? 1 : 0 }).format(allocated / (1024 ** exponent))} ${units[exponent]}`);
  }
  assert.ok(card.buttons.includes('复制设置地址') || card.buttons.includes('Copy settings address'));
  assert.ok(card.buttons.includes('在文件树查看') || card.buttons.includes('View in file tree'));
  assert.equal(card.buttons.some(label => /移入回收站|Move to Trash|立即清理|Clean now/i.test(label)), false);
  await waitForUI('native guide opens', () => {
    const section = document.querySelector('section[aria-label="Browser cache"], section[aria-label="浏览器缓存"]');
    const summary = [...(section?.querySelectorAll('summary') || [])].find(node => ['Clean up in the browser', '在浏览器中清理'].includes(node.textContent.trim()));
    if (!summary) return false;
    if (!summary.parentElement.open) summary.click();
    return summary.parentElement.open;
  });
  await clickButton(['Copy settings address', '复制设置地址'], 'section[aria-label="Browser cache"] article button, section[aria-label="浏览器缓存"] article button');
  await waitForUI('copied settings confirmation', () => [...document.querySelectorAll('[role="status"]')].some(node => /Settings address copied|设置地址已复制/.test(node.textContent)));
  assert.equal(await clipboard.readText(), settingsAddress);
  assert.deepEqual(await call('history'), []);
  assert.equal(trashCalls, 0);
  await fs.writeFile(path.join(base, 'cache-guidance.png'), (await window.webContents.capturePage()).toPNG());
  report.screenshot = path.join(base, 'cache-guidance.png');
  report.checks.push('The real cache card displays indexed allocated/logical bytes and file count, provides guidance only, and copies the fixed browser settings address without creating a cleanup record.');

  const blocked = await call('planCleanup', [finding.entry.id]);
  assert.equal(blocked.items.length, 1);
  assert.equal(blocked.items[0].eligible, false);
  assert.equal(blocked.totalBytes, 0);
  assert.equal(blocked.items[0].reason, process.platform === 'linux' ? 'HIDDEN_PATH' : 'APPLICATION_DATA');
  report.checks.push('Existing cleanup protection still refuses hidden cache, AppData, or Library content.');

  await clickButton(['View in file tree', '在文件树查看'], 'section[aria-label="Browser cache"] article button, section[aria-label="浏览器缓存"] article button');
  await waitForUI('cache directory opens in real file tree', target => {
    const input = document.querySelector('input[aria-label="Search scanned items"], input[aria-label="搜索已扫描内容"]');
    return input && !input.disabled && document.querySelector('button[aria-current="location"]')?.title === target;
  }, cacheDirectory);
  report.checks.push('View in file tree resolves the current cache entry and navigates to its real directory.');

  await clickButton(['Make room', '整理空间'], 'nav button');
  await currentCard();
  const second = await startThroughUI(emptyScope);
  await assert.rejects(call('cacheReport', first.scanId), /SCAN_CHANGED/);
  const empty = await call('cacheReport', second.scanId);
  assert.equal(empty.rootPath, emptyScope);
  assert.deepEqual(empty.findings, []);
  await waitFor('empty rescan removes the previous cache card', async () => {
    const ui = await render(cacheUI);
    return ui && !ui.loading && ui.cards.length === 0 && !ui.text.includes(cacheDirectory);
  });
  await render(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal((await render(cacheUI)).cards.length, 0);
  assert.deepEqual(await call('history'), []);
  assert.equal(trashCalls, 0);
  assert.equal((await fs.stat(path.join(cacheData, 'cached-response'))).size, 137000);
  assert.equal((await fs.stat(path.join(cacheData, 'index'))).size, 31);
  assert.deepEqual(report.errors, []);
  report.checks.push('A fresh empty scope rejects the old scan token, drops stale cache cards, and preserves every fixture and cleanup record.');
}

try {
  for (const directory of [cacheData, fakeDirectory, emptyScope, userData, process.env.XDG_DATA_HOME]) fsSync.mkdirSync(directory, { recursive: true });
  fsSync.writeFileSync(path.join(cacheData, 'cached-response'), Buffer.alloc(137000, 65));
  fsSync.writeFileSync(path.join(cacheData, 'index'), Buffer.alloc(31, 66));
  fsSync.writeFileSync(path.join(fakeDirectory, 'not-browser-data.txt'), 'This lookalike is ordinary user content.');
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
