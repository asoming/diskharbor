'use strict';

// Synthetic path-rule fixtures only: this does not test Windows hidden
// attributes, Finder flags, or real user/system folders. No Trash call is allowed.
const { app, ipcMain, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const workerThreads = require('node:worker_threads');

const base = process.env.DISKHARBOR_VISIBILITY_SMOKE_DIR;
assert.ok(base && path.isAbsolute(base) && path.basename(base).startsWith('visibility-smoke-'));
const home = path.join(base, 'home');
const userData = path.join(base, 'user-data');
const bootstrap = path.join(base, 'worker-bootstrap.cjs');
const hidden = path.join(home, '.hidden-zone');
const ordinary = path.join(home, 'ordinary-parent');
const paging = path.join(home, 'paging');
const system = path.join(home, process.platform === 'win32' ? 'AppData' : process.platform === 'darwin' ? 'Library' : '.cache');
const cache = process.platform === 'win32'
  ? path.join(system, 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Cache')
  : process.platform === 'darwin'
    ? path.join(system, 'Caches', 'Google', 'Chrome', 'Default', 'Cache')
    : path.join(system, 'google-chrome', 'Default', 'Cache');
const other = path.join(base, 'other-scope');
const report = {
  platform: process.platform, checks: [], errors: [],
  boundary: 'Synthetic trusted home and known path layouts; real metadata, worker, IPC and renderer. Native Windows hidden attributes and macOS Finder flags are not exercised. All Trash calls fail closed.',
};
const fixtures = [];
const originalHome = os.homedir;
const originalGetPath = app.getPath;
const originalTrash = shell.trashItem;
const originalHandle = ipcMain.handle;
const NativeWorker = workerThreads.Worker;
let window;
let finishing = false;
let trashCalls = 0;
let holdQuery = false;
let heldQuery;
let releaseQuery;
let holdCacheResolve = false;
let heldCacheResolve;
let releaseCacheResolve;

os.homedir = () => home;
app.getPath = function (name) { return name === 'home' ? home : originalGetPath.call(this, name); };
shell.trashItem = async () => { trashCalls += 1; throw new Error('Visibility smoke must never mutate files through Trash.'); };
workerThreads.Worker = class VisibilityWorker extends NativeWorker {
  constructor(filename, options) {
    const controlled = path.basename(String(filename)) === 'scan-worker.cjs';
    super(controlled ? bootstrap : filename, controlled ? {
      ...options, workerData: { ...options.workerData, visibilityHarness: { entry: String(filename), home } },
    } : options);
  }
};
ipcMain.handle = function (channel, listener) {
  if (!['diskharbor:query', 'diskharbor:resolvePaths'].includes(channel)) return originalHandle.call(this, channel, listener);
  return originalHandle.call(this, channel, async (event, ...args) => {
    const query = args[0];
    const hold = channel === 'diskharbor:query' && holdQuery && query?.search === 'record-' && query.includeHidden === true && query.includeSystem === true;
    const holdCache = channel === 'diskharbor:resolvePaths' && holdCacheResolve && Array.isArray(query) && query.length === 1 && query[0] === cache;
    if (hold) holdQuery = false;
    if (holdCache) holdCacheResolve = false;
    const result = await listener(event, ...args);
    if (hold) {
      heldQuery = { query, result };
      await new Promise(resolve => { releaseQuery = resolve; });
    }
    if (holdCache) {
      heldCacheResolve = result;
      await new Promise(resolve => { releaseCacheResolve = resolve; });
    }
    return result;
  });
};
app.setPath('userData', userData);
app.setPath('sessionData', path.join(userData, 'session'));
app.commandLine.appendSwitch('disable-gpu');
const watchdog = setTimeout(() => finish(new Error('Visibility desktop smoke timed out.')), 120000);

async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  releaseQuery?.();
  releaseCacheResolve?.();
  os.homedir = originalHome;
  app.getPath = originalGetPath;
  shell.trashItem = originalTrash;
  ipcMain.handle = originalHandle;
  workerThreads.Worker = NativeWorker;
  report.result = error ? 'failed' : 'passed';
  if (error) {
    report.error = String(error.stack || error);
    if (window && !window.isDestroyed()) {
      report.ui = await render(explorerUI).catch(() => null);
      report.visibleStatus = await render(() => [...document.querySelectorAll('[role="status"], [role="alert"]')].map(node => node.textContent)).catch(() => []);
      await fs.writeFile(path.join(base, 'failure.png'), (await window.webContents.capturePage()).toPNG()).catch(() => {});
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
  throw new Error(`Visibility smoke wait failed: ${description}`);
}
function waitUI(description, read, ...args) { return waitFor(description, () => render(read, ...args)); }
async function settle() { await render(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function clickButton(labels, selector = 'button') {
  await waitUI(`button ${labels.join(' / ')}`, (names, scope) => {
    const button = [...document.querySelectorAll(scope)].find(node => names.includes(node.textContent.trim()) || [...node.querySelectorAll(':scope > span')].some(span => names.includes(span.textContent.trim())));
    if (!button || button.disabled || !button.getClientRects().length) return false;
    button.focus({ preventScroll: true }); button.click(); return true;
  }, labels, selector);
}
async function scan(target) {
  const previous = await call('summary');
  await waitUI('editable scan path', value => {
    const input = document.querySelector('input[aria-label="Scan path"], input[aria-label="扫描路径"]');
    if (!input || input.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); return true;
  }, target);
  await clickButton(['Start scan', '开始扫描', 'Scan again', '重新扫描'], 'section[aria-label="Scan location"] button, section[aria-label="扫描位置"] button');
  const result = await waitFor('new completed scan', async () => {
    let summary;
    try { summary = await call('summary'); }
    catch (error) { if (/SCAN_REPLACED|NO_SCAN/.test(String(error))) return false; throw error; }
    if (summary?.state === 'error') throw new Error(summary.message || 'Scan failed.');
    return summary?.state === 'completed' && summary.scanId !== previous?.scanId ? summary : false;
  });
  await waitUI('display controls for completed scan', () => document.querySelectorAll('.view-filters input[type="checkbox"]:not(:disabled)').length === 2);
  return result;
}
function flags() {
  return [...document.querySelectorAll('.view-filters input[type="checkbox"]')].map(input => input.checked);
}
async function setFlag(index, checked, keyboard = false) {
  await waitUI('enabled display checkbox', i => {
    const input = document.querySelectorAll('.view-filters input[type="checkbox"]')[i];
    return input && !input.disabled;
  }, index);
  const old = await render(flags);
  if (old[index] === checked) return;
  await render((i, useKeyboard) => {
    const input = document.querySelectorAll('.view-filters input[type="checkbox"]')[i];
    input.scrollIntoView({ block: 'nearest' }); input.focus(); if (!useKeyboard) input.click();
  }, index, keyboard);
  if (keyboard) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  }
  await waitUI('checkbox toggled', (i, value) => document.querySelectorAll('.view-filters input[type="checkbox"]')[i]?.checked === value, index, checked);
  await settle();
}
async function setSearch(value) {
  await waitUI('search input ready', text => {
    const input = document.querySelector('.fx-search input');
    if (!input || input.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true })); return true;
  }, value);
}
function explorerUI() {
  const grid = document.querySelector('[role="treegrid"], [role="grid"]');
  return {
    location: document.querySelector('button[aria-current="location"]')?.title,
    search: document.querySelector('.fx-search input')?.value,
    ready: !!document.querySelector('.fx-search input:not(:disabled)') && ![...document.querySelectorAll('[role="status"]')].some(node => /正在恢复浏览位置|Restoring your location/.test(node.textContent)),
    total: parseInt(document.querySelector('.fx-result-count')?.textContent.replace(/,/g, '') || '0', 10),
    filtered: parseInt(document.querySelector('.fx-filtered-count')?.textContent.replace(/,/g, '') || '0', 10),
    loaded: parseInt(document.querySelector('.fx-footer > span')?.textContent.replace(/,/g, '') || '0', 10),
    paths: [...(grid?.querySelectorAll('.fx-filename') || [])].map(node => node.title),
    selected: !!document.querySelector('.fx-selection-count'),
    details: document.querySelector('.detail-path')?.textContent,
    flags: [...document.querySelectorAll('.view-filters input[type="checkbox"]')].map(node => node.checked),
  };
}
async function explorerReady() {
  await waitFor('explorer ready', async () => (await render(explorerUI)).ready);
  await settle();
}
async function expectResults(total, filtered, search) {
  return waitFor(`query results ${total}, excluded ${filtered}`, async () => {
    const ui = await render(explorerUI);
    return ui.ready && ui.total === total && ui.filtered === filtered && (search === undefined || ui.search === search) ? ui : false;
  });
}
async function rowAction(target, action) {
  await waitUI(`${action} ${target}`, (filePath, operation) => {
    if (document.querySelector('.fx-search input')?.disabled) return false;
    const row = [...document.querySelectorAll('.fx-filename')].find(node => node.title === filePath)?.closest('[role="row"]');
    if (!row) return false;
    if (operation === 'select') { const input = row.querySelector('input'); if (!input || input.disabled) return false; if (!input.checked) input.click(); }
    else { row.click(); if (operation === 'enter') row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }
    return true;
  }, target, action);
}
async function navigate(labels) { await clickButton(labels, '.sidebar button'); await settle(); }
async function allEntries(query = {}) {
  const result = []; let response;
  do {
    response = await call('query', { ...query, limit: 100, offset: result.length });
    result.push(...response.entries);
  } while (result.length < response.total);
  return { entries: result, total: response.total, filteredCount: response.filteredCount };
}
function mark(message) { report.checks.push(message); }

async function execute() {
  const prefs = window.webContents.getLastWebPreferences();
  assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.sandbox, true);
  assert.equal(app.commandLine.hasSwitch('no-sandbox'), false);
  assert.match(window.webContents.getURL(), /^diskharbor:\/\/app\//);
  assert.equal((await call('info')).home, home);
  assert.equal(await call('summary'), null); assert.deepEqual(await call('history'), []);
  const first = await scan(home);
  assert.deepEqual(await render(flags), [false, false]);
  const all = await allEntries({ includeHidden: true, includeSystem: true });
  const byPath = new Map(all.entries.map(entry => [entry.path, entry]));
  assert.equal(byPath.get(path.join(hidden, 'record-hidden.txt')).hiddenPath, true);
  assert.equal(byPath.get(path.join(hidden, 'record-hidden.txt')).systemPath, false);
  assert.equal(byPath.get(path.join(system, 'record-system.txt')).systemPath, true);
  assert.equal(byPath.get(path.join(system, 'record-system.txt')).hiddenPath, process.platform === 'linux');
  assert.equal(byPath.get(path.join(home, 'Documents', 'Windows', 'ordinary.txt')).systemPath, false);
  assert.equal(byPath.get(path.join(home, 'Documents', 'Windows', 'ordinary.txt')).hiddenPath, false);
  const omitted = await call('query', { kind: 'file', search: 'record-', limit: 100 });
  assert.equal(omitted.total, 123); assert.equal(omitted.filteredCount, undefined);
  for (const [includeHidden, includeSystem, total] of [[false, false, 121], [true, false, 122], [false, true, process.platform === 'linux' ? 121 : 122], [true, true, 123]]) {
    const result = await allEntries({ search: 'record-', kind: 'file', sortBy: 'name', sortDirection: 'asc', includeHidden, includeSystem });
    assert.equal(result.total, total); assert.equal(result.filteredCount, 123 - total);
    assert.equal(new Set(result.entries.map(entry => entry.path)).size, total);
    assert.equal(result.entries.some(entry => entry.path === path.join(hidden, 'record-hidden.txt')), includeHidden);
    assert.equal(result.entries.some(entry => entry.path === path.join(system, 'record-system.txt')), includeSystem && (includeHidden || process.platform !== 'linux'));
  }
  for (const key of ['includeHidden', 'includeSystem']) for (const invalid of ['false', 0, null, [], {}]) await assert.rejects(call('query', { [key]: invalid }), /INVALID_QUERY/);
  report.query = { recordsIncludingHidden: 123, recordsDefaultVisible: 121, overlapOnLinux: process.platform === 'linux' };
  mark('Real worker queries apply both path filters after matching, deduplicate exclusions, preserve paging and legacy omitted flags, and reject non-boolean flags.');

  await waitUI('overview candidates loaded', () => document.querySelectorAll('.large-file').length > 0);
  const overview = await render(() => ({ files: [...document.querySelectorAll('.large-file strong')].map(node => node.title), folders: [...document.querySelectorAll('.folder-row > span')].map(node => node.textContent) }));
  assert.ok(!overview.files.includes('hidden-largest.bin') && !overview.files.includes('system-largest.bin'));
  assert.ok(!overview.folders.includes(path.basename(hidden)) && !overview.folders.includes(path.basename(system)));
  await navigate(['文件树', 'File tree']); await explorerReady();
  let ui = await render(explorerUI); assert.ok(!ui.paths.includes(hidden) && !ui.paths.includes(system));
  await setSearch('hidden-largest'); await expectResults(0, 1, 'hidden-largest');
  mark('Default overview candidates, root tree and global search hide excluded paths and descendants while retaining explicit excluded-result counts.');

  await setSearch(''); await explorerReady();
  await rowAction(path.join(home, 'visible-largest.bin'), 'select');
  await rowAction(path.join(home, 'visible-largest.bin'), 'inspect');
  await waitFor('selection and details exist before toggle', async () => { const value = await render(explorerUI); return value.selected && value.details === path.join(home, 'visible-largest.bin'); });
  await setFlag(0, true, true);
  await waitFor('toggle clears selection and details', async () => { const value = await render(explorerUI); return !value.selected && !value.details && value.paths.includes(hidden); });
  await waitUI('selection clearing announced', () => [...document.querySelectorAll('[role="status"]')].some(node => /已清除勾选与详情|Selection and details were cleared/.test(node.textContent)));
  await setFlag(1, true, true);
  assert.deepEqual(await call('summary'), first); assert.deepEqual(await call('history'), []);
  mark('Both checkboxes respond to real Space key input; changing display clears selection and details with an announcement, without changing scan totals, categories, volume or history.');

  await rowAction(hidden, 'enter');
  await waitFor('hidden directory entered', async () => (await render(explorerUI)).location === hidden);
  await setFlag(0, false);
  await waitFor('hidden scope returns to a visible ancestor', async () => { const value = await render(explorerUI); return value.ready && value.location === home && !value.paths.includes(hidden); });
  await setFlag(1, false);
  const protectedPlan = await call('planCleanup', [byPath.get(ordinary).id]);
  assert.equal(protectedPlan.items.length, 1); assert.equal(protectedPlan.items[0].eligible, false);
  assert.equal(protectedPlan.items[0].reason, 'UNSAFE_DESCENDANT');
  assert.ok(protectedPlan.items[0].blockedPath.startsWith(path.join(ordinary, '.private')));
  assert.equal(protectedPlan.totalBytes, 0); assert.equal(trashCalls, 0);
  mark('Closing hidden visibility moves an excluded current directory to a visible ancestor; selecting an ordinary parent still checks hidden descendants and refuses unsafe whole-directory cleanup.');

  await setSearch('record-'); await expectResults(121, 2, 'record-');
  await waitUI('initial page has completed real layout', () => {
    const viewport = document.querySelector('.fx-viewport'); const declared = parseFloat(document.querySelector('.fx-virtual-space')?.style.height || '0');
    return viewport && declared >= 5000 && viewport.clientHeight > 0 && Math.abs(viewport.scrollHeight - declared) <= 1;
  });
  const scroll = await render(() => { const viewport = document.querySelector('.fx-viewport'); viewport.scrollTop = viewport.scrollHeight; return { actual: viewport.scrollTop, end: viewport.scrollHeight - viewport.clientHeight }; });
  assert.ok(Math.abs(scroll.actual - scroll.end) <= 1);
  await clickButton(['加载更多 · 21 / 21', 'Load more · 21 / 21'], '.fx-load-row button');
  await waitFor('second visible page loaded', async () => (await render(explorerUI)).loaded === 121);
  await setFlag(0, true); await expectResults(122, 1, 'record-');
  holdQuery = true;
  await setFlag(1, true);
  await waitFor('old show-all query held after real worker response', () => heldQuery && releaseQuery);
  assert.equal(heldQuery.result.total, 123); assert.equal(heldQuery.result.filteredCount, 0);
  await setFlag(0, false); await expectResults(process.platform === 'linux' ? 121 : 122, process.platform === 'linux' ? 2 : 1, 'record-');
  const beforeRelease = await render(explorerUI);
  releaseQuery(); releaseQuery = null;
  await settle(); await settle();
  ui = await render(explorerUI);
  assert.equal(ui.total, beforeRelease.total); assert.equal(ui.filtered, beforeRelease.filtered);
  assert.ok(!ui.paths.some(item => item.startsWith(hidden + path.sep)));
  assert.equal(ui.flags[0], false);
  report.lateQuery = { heldTotal: heldQuery.result.total, currentTotal: ui.total, excluded: ui.filtered };
  mark('Search pagination loads 100 + 21 visible matches; mode changes recompute exclusions and a deliberately delayed genuine show-all query cannot restore hidden rows or old counts.');

  await setSearch(''); await setFlag(1, false);
  await navigate(['整理空间', 'Make room']);
  await waitUI('cache guide card ready', target => [...document.querySelectorAll('section[aria-label="Browser cache"] [title], section[aria-label="浏览器缓存"] [title]')].some(node => node.title === target), cache);
  holdCacheResolve = true;
  await clickButton(['在文件树查看', 'View in file tree'], 'section[aria-label="Browser cache"] article button, section[aria-label="浏览器缓存"] article button');
  await waitFor('cache path resolve held after real indexed response', () => heldCacheResolve && releaseCacheResolve);
  assert.equal(heldCacheResolve[0].path, cache);
  await navigate(['空间概览', 'Overview']);
  await setFlag(0, true, true);
  releaseCacheResolve(); releaseCacheResolve = null;
  await settle(); await settle();
  assert.deepEqual(await render(flags), [true, false]);
  assert.ok(await render(() => !!document.querySelector('.overview-grid') && !document.querySelector('.fx-explorer')));
  mark('A genuine delayed cache-location response cannot override a later page change or newer display options.');
  await setFlag(0, false);
  await navigate(['整理空间', 'Make room']);
  await clickButton(['在文件树查看', 'View in file tree'], 'section[aria-label="Browser cache"] article button, section[aria-label="浏览器缓存"] article button');
  await waitFor('explicit cache navigation enables necessary options', async () => { const value = await render(explorerUI); return value.ready && value.location === cache && value.flags[1] && (process.platform !== 'linux' || value.flags[0]); });
  mark('Explicit browser-cache navigation enables the required path visibility and opens that indexed directory without granting cleanup permission.');

  await setFlag(0, true); await setFlag(1, true);
  await navigate(['操作记录', 'Activity']); await navigate(['文件树', 'File tree']); await explorerReady();
  assert.deepEqual(await render(flags), [true, true]);
  await scan(home); await explorerReady(); assert.deepEqual(await render(flags), [true, true]);
  await navigate(['设置', 'Settings']);
  await waitUI('switch English', () => {
    const select = document.querySelector('select[aria-label="界面语言"], select[aria-label="Interface language"]');
    if (!select) return false; select.value = 'en'; select.dispatchEvent(new Event('change', { bubbles: true })); return true;
  });
  await navigate(['File tree']); await explorerReady(); assert.deepEqual(await render(flags), [true, true]);
  assert.equal(await render(() => document.documentElement.lang), 'en');
  mark('Display options survive a page round trip, same-root rescan and language switch within the current renderer session.');

  const dotScan = await scan(hidden); await explorerReady();
  assert.deepEqual(await render(flags), [false, false]);
  const dotFiles = await allEntries({ kind: 'file', includeHidden: false, includeSystem: false });
  assert.ok(dotFiles.entries.some(entry => entry.name === 'hidden-largest.bin'));
  assert.ok(!dotFiles.entries.some(entry => entry.name === 'nested-dot.txt'));
  assert.equal(dotFiles.filteredCount, 1); assert.equal(dotScan.visibility.rootIsSystem, false);
  await waitFor('explicit dot root is visible', async () => (await render(explorerUI)).paths.includes(path.join(hidden, 'hidden-largest.bin')));
  const systemScan = await scan(system); await explorerReady();
  assert.equal(systemScan.visibility.rootIsSystem, true);
  assert.deepEqual(await render(flags), [false, false]);
  await waitFor('explicit system root is visible', async () => (await render(explorerUI)).paths.includes(path.join(system, 'system-largest.bin')));
  const systemFiles = await allEntries({ kind: 'file', includeHidden: false, includeSystem: false });
  assert.ok(systemFiles.entries.some(entry => entry.name === 'system-largest.bin'));
  assert.ok(!systemFiles.entries.some(entry => entry.name === '.system-dot.txt'));
  mark('An explicitly chosen dot or known-system root is browsable by default; newly dot-prefixed descendants remain filtered, with root-system scope reported explicitly.');

  await scan(other); await explorerReady(); assert.deepEqual(await render(flags), [false, false]);
  await clickButton(['Show all items'], '.view-filters button');
  await waitUI('show all enables both', () => [...document.querySelectorAll('.view-filters input')].every(input => input.checked));
  await waitFor('show all exposes the hidden fixture', async () => (await render(explorerUI)).paths.includes(path.join(other, '.other-hidden.txt')));
  await scan(home); await explorerReady(); assert.deepEqual(await render(flags), [false, false]);
  mark('A different root resets options; the explicit Show all items action enables both categories and exposes their indexed entries.');

  window.setContentSize(1024, 700);
  for (const language of ['en', 'zh-CN']) {
    if (language === 'zh-CN') {
      await navigate(['Settings']);
      await waitUI('switch Chinese', () => { const select = document.querySelector('select[aria-label="Interface language"]'); if (!select) return false; select.value = 'zh-CN'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; });
      await navigate(['文件树']); await explorerReady();
    }
    await waitUI('filter explanation expanded', () => { const detail = document.querySelector('.view-filters-details'); if (!detail) return false; if (!detail.open) detail.querySelector('summary').click(); return detail.open; });
    await settle();
    const layout = await render(() => ({
      width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
      labels: [...document.querySelectorAll('.view-filters label')].map(node => node.textContent),
      controls: [...document.querySelectorAll('.view-filters input, .view-filters button, .view-filters summary')].map(node => { const rect = node.getBoundingClientRect(); return { width: rect.width, left: rect.left, right: rect.right, disabled: node.disabled === true, tabIndex: node.tabIndex }; }),
      rules: document.querySelector('.view-filters-details')?.textContent,
    }));
    assert.equal(layout.width, 1024); assert.equal(layout.overflow, false);
    assert.equal(layout.controls.length, 4);
    assert.ok(layout.controls.every(control => control.width > 0 && control.left >= 0 && control.right <= 1024 && !control.disabled && control.tabIndex >= 0));
    assert.match(layout.rules, language === 'en' ? /Windows hidden attributes.*macOS Finder hidden flags/ : /Windows 隐藏属性.*macOS Finder 隐藏标记/);
    await setFlag(0, true, true); await setFlag(0, false, true);
    const screenshot = path.join(base, `visibility-${language}-1024.png`);
    await fs.writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
    (report.layouts ||= []).push({ language, ...layout, screenshot });
  }
  assert.deepEqual(await call('history'), []); assert.equal(trashCalls, 0);
  for (const fixture of fixtures) assert.equal((await fs.stat(fixture.path)).size, fixture.size);
  assert.deepEqual(report.errors, []);
  mark('At 1024×700 both languages expose keyboard-operable controls and precise path-rule limits without horizontal body overflow; all synthetic files and history remain unchanged, with zero Trash calls or renderer errors.');
}

function file(target, size = 17) {
  fsSync.mkdirSync(path.dirname(target), { recursive: true });
  fsSync.writeFileSync(target, Buffer.alloc(size, 65));
  fixtures.push({ path: target, size });
}
try {
  for (const directory of [home, userData, process.env.XDG_DATA_HOME]) fsSync.mkdirSync(directory, { recursive: true });
  file(path.join(home, 'visible-largest.bin'), 100000);
  file(path.join(home, 'Documents', 'Windows', 'ordinary.txt'));
  file(path.join(hidden, 'hidden-largest.bin'), 400000);
  file(path.join(hidden, 'record-hidden.txt'), 300000);
  file(path.join(hidden, '.nested', 'nested-dot.txt'));
  file(path.join(system, 'system-largest.bin'), 500000);
  file(path.join(system, 'record-system.txt'), 200000);
  file(path.join(system, '.system-dot.txt'));
  file(path.join(cache, 'Cache_Data', 'cached-response'), 137000);
  file(path.join(ordinary, 'public.txt'));
  file(path.join(ordinary, '.private', 'secret.txt'));
  for (let i = 0; i < 121; i += 1) file(path.join(paging, `record-${String(i).padStart(3, '0')}.txt`));
  file(path.join(other, 'other-visible.txt')); file(path.join(other, '.other-hidden.txt'));
  fsSync.writeFileSync(bootstrap, "'use strict';\nconst {workerData}=require('node:worker_threads');\nrequire('node:os').homedir=()=>workerData.visibilityHarness.home;\nrequire(workerData.visibilityHarness.entry);\n");
  app.on('browser-window-created', (_event, created) => {
    if (window) return;
    window = created;
    window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') report.errors.push(details.message); });
    window.webContents.once('did-finish-load', () => execute().then(() => finish(), finish));
  });
  require('../electron/main.cjs');
} catch (error) { void finish(error); }
