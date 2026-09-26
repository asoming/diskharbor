'use strict';

// A separate production-renderer harness. Its temporary worker bootstrap only
// delays or rejects opendir for its own synthetic paths; production has no hook.
const { app, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const workerThreads = require('node:worker_threads');

const base = process.env.DISKHARBOR_NAVIGATION_SMOKE_DIR;
assert.ok(base && path.isAbsolute(base) && path.basename(base).startsWith('navigation-smoke-'));
const fixtures = path.join(base, 'files');
const cancelRoot = path.join(fixtures, 'cancel-target');
const lateReplyRoot = path.join(fixtures, 'late-reply-target');
const treeRoot = path.join(fixtures, 'navigation');
const projects = path.join(treeRoot, 'projects');
const scopeA = path.join(projects, 'a');
const nested = path.join(scopeA, '000-nested');
const failureRoot = path.join(fixtures, 'failures');
const denied = path.join(failureRoot, 'denied');
const userData = path.join(base, 'user-data');
const bootstrap = path.join(base, 'worker-bootstrap.cjs');
const report = { platform: process.platform, checks: [], errors: [] };
const NativeWorker = workerThreads.Worker;
const originalHandle = ipcMain.handle;
const createdWorkers = [];
let nextControl = null;
let heldWorker;
let window;
let finishing = false;
let holdNextCancelReply = false;
let releaseCancelReply;
let captureNavigationFocus = false;

ipcMain.handle = function (channel, listener) {
  return originalHandle.call(this, channel, channel === 'diskharbor:cancelScan' ? async (event, ...args) => {
    const hold = holdNextCancelReply;
    holdNextCancelReply = false;
    const result = await listener(event, ...args);
    if (hold) await new Promise(resolve => { releaseCancelReply = resolve; });
    return result;
  } : listener);
};

workerThreads.Worker = class NavigationWorker extends NativeWorker {
  constructor(filename, options) {
    const controlled = path.basename(String(filename)) === 'scan-worker.cjs';
    const control = controlled ? nextControl : null;
    if (controlled) nextControl = null;
    super(controlled ? bootstrap : filename, controlled ? {
      ...options, workerData: { ...options.workerData, navigationHarness: { entry: String(filename), ...control } },
    } : options);
    this.navigationDelayProgress = control?.delayFirstProgress === true;
    if (controlled) {
      createdWorkers.push({ rootPath: options.workerData.rootPath, scanId: options.workerData.scanId });
      this.on('message', message => {
        if (message?.type === 'navigation-harness-gated') heldWorker = this;
      });
    }
  }
  emit(event, ...args) {
    const message = args[0];
    if (event === 'message' && this.navigationDelayProgress && message?.type === 'progress' && message.summary?.state === 'scanning') {
      this.navigationDelayProgress = false;
      this.navigationDelayedProgress = message;
      return true;
    }
    return super.emit(event, ...args);
  }
  releaseProgress() {
    assert.ok(this.navigationDelayedProgress, 'A real scanning message must have been queued.');
    const message = this.navigationDelayedProgress;
    this.navigationDelayedProgress = null;
    super.emit('message', message);
  }
};

app.setPath('userData', userData);
app.setPath('sessionData', path.join(userData, 'session'));
app.commandLine.appendSwitch('disable-gpu');
const watchdog = setTimeout(() => finish(new Error('Navigation desktop smoke timed out.')), 90000);

async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  workerThreads.Worker = NativeWorker;
  ipcMain.handle = originalHandle;
  releaseCancelReply?.();
  heldWorker?.postMessage({ type: 'navigation-harness-release' });
  report.result = error ? 'failed' : 'passed';
  if (error) {
    report.error = String(error.stack || error);
    if (window && !window.isDestroyed()) {
      report.navigationScrollMutations = await render(stopScrollDiagnostics).catch(() => []);
      report.ui = await render(treeUI).catch(() => null);
      report.visibleStatus = await render(() => [...document.querySelectorAll('[role="status"], [role="alert"]')].map(node => node.textContent)).catch(() => []);
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
  throw new Error(`Navigation smoke wait failed: ${description}`);
}
function waitForUI(description, read, ...args) {
  return waitFor(description, () => render(read, ...args));
}
async function clickButton(labels, selector = 'button') {
  const outcome = await waitForUI(`button ${labels.join(' / ')}`, (names, scope, captureFocus) => {
    const button = [...document.querySelectorAll(scope)].find(node => names.includes(node.textContent.trim()) || [...node.querySelectorAll(':scope > span')].some(span => names.includes(span.textContent.trim())));
    if (!button || button.disabled || !button.getClientRects().length) return false;
    const viewport = document.querySelector('[role="treegrid"] [role="rowgroup"]');
    const snapshot = () => viewport ? { top: viewport.scrollTop, left: viewport.scrollLeft, clientHeight: viewport.clientHeight, scrollHeight: viewport.scrollHeight } : null;
    const before = captureFocus ? snapshot() : null;
    button.focus();
    const after = captureFocus ? snapshot() : null;
    button.click();
    return { clicked: true, ...(captureFocus ? { focus: { button: button.textContent.trim(), withinViewport: !!viewport?.contains(button), before, after } } : {}) };
  }, labels, selector, captureNavigationFocus);
  if (outcome.focus) (report.navigationFocus ??= []).push(outcome.focus);
}
async function setScanPath(target) {
  await waitForUI('editable scan path', value => {
    const input = document.querySelector('input[aria-label="Scan path"], input[aria-label="扫描路径"]');
    if (!input || input.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, target);
}
async function completedScan(previousId) {
  return waitFor('new completed scan', async () => {
    let summary;
    try { summary = await call('summary'); }
    catch (error) {
      if (/(?:^|:\s*)(?:SCAN_REPLACED|NO_SCAN)$/.test(String(error?.message || error))) return false;
      throw error;
    }
    if (summary?.state === 'error') throw new Error(summary.message || 'Scan failed.');
    return summary?.state === 'completed' && summary.scanId !== previousId ? summary : false;
  });
}
async function startThroughUI(target) {
  const previous = await call('summary');
  await setScanPath(target);
  await clickButton(['Start scan', '开始扫描', 'Scan again', '重新扫描']);
  return completedScan(previous?.scanId);
}
async function rowAction(filePath, action) {
  await waitForUI(`${action} row ${filePath}`, (target, requested) => {
    const search = document.querySelector('input[aria-label="Search scanned items"], input[aria-label="搜索已扫描内容"]');
    if (search?.disabled) return false;
    const grid = document.querySelector('[role="treegrid"], [role="grid"]');
    const label = [...(grid?.querySelectorAll('[role="row"] [title]') || [])].find(node => node.title === target && node.textContent.trim() === target.split(/[\\/]/).pop());
    const row = label?.closest('[role="row"]');
    if (!row) return false;
    if (requested === 'expand') {
      if (row.getAttribute('aria-expanded') === 'true') return true;
      const button = [...row.querySelectorAll('button[aria-label]')].find(node => /^(?:展开|Expand):/.test(node.getAttribute('aria-label')));
      if (!button) return false;
      button.click();
    } else if (requested === 'enter') {
      row.click();
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    } else if (requested === 'select') {
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (!checkbox || checkbox.disabled) return false;
      if (!checkbox.checked) checkbox.click();
    } else row.click();
    return true;
  }, filePath, action);
}
function treeUI() {
  const grid = document.querySelector('[role="treegrid"], [role="grid"]');
  const viewport = grid?.querySelector('[role="rowgroup"]');
  const location = document.querySelector('nav[aria-label="Current location"] button[aria-current="location"], nav[aria-label="当前位置"] button[aria-current="location"]');
  const search = document.querySelector('input[aria-label="Search scanned items"], input[aria-label="搜索已扫描内容"]');
  const active = document.getElementById(grid?.getAttribute('aria-activedescendant') || '');
  const activeLabel = [...(active?.querySelectorAll('[title]') || [])].find(node => node.title && node.textContent.trim() === node.title.split(/[\\/]/).pop());
  return {
    location: location?.title,
    search: search?.value,
    minimum: document.querySelector('select[title="Minimum file size (logical size)"], select[title="最小文件大小（逻辑大小）"]')?.value,
    top: viewport?.scrollTop,
    left: viewport?.scrollLeft,
    clientHeight: viewport?.clientHeight,
    scrollHeight: viewport?.scrollHeight,
    virtualHeight: viewport?.querySelector('.fx-virtual-space')?.style.height,
    rowCount: grid?.getAttribute('aria-rowcount'),
    activeDescendant: grid?.getAttribute('aria-activedescendant'),
    activePath: activeLabel?.title,
    columns: [...(grid?.querySelectorAll('[role="columnheader"]') || [])].map(node => ({ text: node.textContent.trim(), sort: node.getAttribute('aria-sort') })),
    rows: [...(grid?.querySelectorAll('[role="row"]') || [])].flatMap(row => {
      const label = [...row.querySelectorAll('[title]')].find(node => node.title && node.textContent.trim() === node.title.split(/[\\/]/).pop());
      return label ? [{ path: label.title, expanded: row.getAttribute('aria-expanded'), selected: row.getAttribute('aria-selected') }] : [];
    }),
  };
}
async function settleUI() {
  await render(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function waitForExplorerReady() {
  await waitForUI('explorer restoration completes before preserving its location', () => {
    const search = document.querySelector('input[aria-label="Search scanned items"], input[aria-label="搜索已扫描内容"]');
    return search && !search.disabled && ![...document.querySelectorAll('[role="status"]')].some(node => /正在恢复浏览位置|Restoring your location/.test(node.textContent));
  });
  await settleUI();
}
function startScrollDiagnostics() {
  // Harness-only observation: preserve the native setter and event behavior.
  // Record whether application assignments are clamped immediately or whether
  // a later browser scroll changes the value after virtual rows are replaced.
  let owner = HTMLElement.prototype;
  while (owner && !Object.hasOwn(owner, 'scrollTop')) owner = Object.getPrototypeOf(owner);
  const descriptor = owner && Object.getOwnPropertyDescriptor(owner, 'scrollTop');
  if (!descriptor?.get || !descriptor.set) throw new Error('Native scrollTop descriptor unavailable.');
  const events = [];
  const snapshot = (target, kind, requested, before) => {
    if (!(target instanceof HTMLElement) || !target.matches('.fx-viewport')) return;
    const grid = target.closest('[role="treegrid"], [role="grid"]');
    const entry = { kind, at: Math.round(performance.now()), ...(requested === undefined ? {} : { requested, before }),
      top: descriptor.get.call(target), left: target.scrollLeft, clientHeight: target.clientHeight, scrollHeight: target.scrollHeight,
      virtualHeight: target.querySelector('.fx-virtual-space')?.style.height ?? null,
      activeDescendant: grid?.getAttribute('aria-activedescendant') ?? null,
      renderedRows: target.querySelectorAll('[role="row"]').length };
    events.push(entry);
    if (events.length > 100) events.shift();
  };
  Object.defineProperty(owner, 'scrollTop', { ...descriptor, set(value) {
    const before = descriptor.get.call(this);
    descriptor.set.call(this, value);
    snapshot(this, 'assignment', value, before);
  } });
  const onScroll = event => snapshot(event.target, 'scroll');
  document.addEventListener('scroll', onScroll, true);
  const observer = new MutationObserver(() => {
    const target = document.querySelector('.fx-viewport');
    if (target) snapshot(target, 'DOM change');
  });
  // Observe only the mounted explorer surface, including its replacement.
  const main = document.querySelector('main');
  if (main) observer.observe(main, { subtree: true, childList: true });
  window.__diskharborNavigationScrollTrace = { stop() {
    Object.defineProperty(owner, 'scrollTop', descriptor);
    document.removeEventListener('scroll', onScroll, true);
    observer.disconnect();
    return events;
  } };
}
function stopScrollDiagnostics() {
  const trace = window.__diskharborNavigationScrollTrace;
  if (!trace) return [];
  delete window.__diskharborNavigationScrollTrace;
  return trace.stop();
}

async function cancellationChecks() {
  nextControl = { gatePath: cancelRoot, delayFirstProgress: true };
  await setScanPath(cancelRoot);
  await clickButton(['Start scan', '开始扫描']);
  await waitFor('real worker held before fixture opendir', () => heldWorker);
  const initial = await call('summary');
  assert.equal(initial.state, 'scanning');
  holdNextCancelReply = true;
  await clickButton(['Stop scan', '停止扫描']);
  await waitForUI('cancel-requested summary and disabled stopping action', async () => {
    const summary = await window.diskharbor.summary();
    const button = [...document.querySelectorAll('button')].find(node => ['Stopping…', '正在停止…'].includes(node.textContent.trim()));
    return summary?.state === 'scanning' && summary.cancelRequested === true && button?.disabled;
  });
  await waitFor('first cancellation reply retained in harness', () => releaseCancelReply);
  heldWorker.releaseProgress();
  await settleUI();
  assert.equal((await call('summary')).cancelRequested, true);
  assert.equal(await render(() => [...document.querySelectorAll('button')].some(node => ['Stopping…', '正在停止…'].includes(node.textContent.trim()) && node.disabled)), true);
  const workersBefore = createdWorkers.length;
  await assert.rejects(call('startScan', treeRoot), /SCAN_BUSY/);
  const repeated = await call('cancelScan', initial.scanId);
  assert.equal(repeated.state, 'scanning');
  assert.equal(repeated.cancelRequested, true);
  assert.equal(createdWorkers.length, workersBefore, 'A stopping worker must not be replaced early.');
  const locked = await render(() => {
    const input = document.querySelector('input[aria-label="Scan path"], input[aria-label="扫描路径"]');
    const browse = [...document.querySelectorAll('button')].find(node => ['Browse', '选择文件夹'].includes(node.textContent.trim()));
    return { path: input?.disabled, browse: browse?.disabled };
  });
  assert.deepEqual(locked, { path: true, browse: true });
  for (const labels of [['Activity', '操作记录'], ['Settings', '设置']]) {
    await clickButton(labels);
    await waitForUI('stopping status remains visible across navigation', () => [...document.querySelectorAll('[role="status"]')].some(node => /已请求停止|stop requested|waiting for.*(?:read|file)/i.test(node.textContent)));
  }
  assert.equal((await call('summary')).state, 'scanning');
  report.checks.push('Stop requests remain pending across navigation; repeat requests are idempotent and new scans stay blocked.');
  heldWorker.postMessage({ type: 'navigation-harness-release' });
  heldWorker = null;
  await waitFor('real worker cancellation after releasing pending opendir', async () => (await call('summary'))?.state === 'cancelled');
  await clickButton(['Overview', '空间概览'], 'nav button');
  await waitForUI('scan controls unlock only after cancellation finishes', () => {
    const input = document.querySelector('input[aria-label="Scan path"], input[aria-label="扫描路径"]');
    const button = [...document.querySelectorAll('button')].find(node => ['Scan again', '重新扫描'].includes(node.textContent.trim()));
    return input && !input.disabled && button && !button.disabled;
  });
  report.checks.push('Cancellation completes only after the real filesystem wait returns, then scanning unlocks.');
  nextControl = { gatePath: lateReplyRoot };
  await setScanPath(lateReplyRoot);
  await clickButton(['Scan again', '重新扫描']);
  await waitFor('new scan B held before opendir', () => heldWorker);
  const scanB = await call('summary');
  assert.equal(scanB.rootPath, lateReplyRoot);
  assert.equal(scanB.state, 'scanning');
  assert.notEqual(scanB.scanId, initial.scanId);
  releaseCancelReply();
  releaseCancelReply = null;
  await waitForUI('late A reply leaves B controls and path unchanged', target => {
    const input = document.querySelector('input[aria-label="Scan path"], input[aria-label="扫描路径"]');
    const button = [...document.querySelectorAll('button')].find(node => ['Stop scan', '停止扫描'].includes(node.textContent.trim()));
    return input?.value === target && input.disabled && button && !button.disabled;
  }, lateReplyRoot);
  const afterReply = await call('summary');
  assert.equal(afterReply.scanId, scanB.scanId);
  assert.equal(afterReply.state, 'scanning');
  assert.equal(afterReply.cancelRequested, false);
  heldWorker.postMessage({ type: 'navigation-harness-release' });
  heldWorker = null;
  await completedScan(initial.scanId);
  report.checks.push('Delayed progress cannot clear a stop request, and a late cancellation reply cannot replace a newer scan.');
  return initial.scanId;
}

async function navigationChecks(cancelledScanId) {
  // Keep the optional columns wider than the viewport even after the details
  // panel closes on navigation, so horizontal-scroll restoration is observable.
  window.setSize(1024, 780);
  const initial = await startThroughUI(treeRoot);
  await assert.rejects(call('cancelScan', cancelledScanId), /SCAN_CHANGED/);
  assert.equal((await call('summary')).cancelRequested, false);
  await clickButton(['File tree', '文件树'], 'nav button');
  await rowAction(projects, 'enter');
  await rowAction(scopeA, 'enter');
  await waitForUI('entered scope by path', target => document.querySelector('button[aria-current="location"]')?.title === target, scopeA);
  await clickButton(['Name', '名称'], '[role="columnheader"] button');
  await waitForUI('name ascending sort', () => [...document.querySelectorAll('[role="columnheader"]')].some(node => ['Name', '名称'].includes(node.textContent.trim()) && node.getAttribute('aria-sort') === 'ascending'));
  await clickButton(['Columns', '显示列']);
  await render(() => {
    for (const label of document.querySelectorAll('label')) {
      if (!['Logical size', '逻辑大小', 'Modified', '修改时间', 'Scan status', '扫描状态'].includes(label.textContent.trim())) continue;
      const checkbox = label.querySelector('input[type="checkbox"]');
      if (checkbox && !checkbox.checked) checkbox.click();
    }
  });
  await clickButton(['Columns', '显示列']);
  await rowAction(nested, 'expand');
  await waitForUI('nested leaf expanded', target => [...document.querySelectorAll('[role="row"] [title]')].some(node => node.title === target), path.join(nested, 'nested-leaf.txt'));
  await render(() => {
    const viewport = document.querySelector('[role="treegrid"] [role="rowgroup"]');
    viewport.scrollTop = viewport.scrollHeight;
    viewport.dispatchEvent(new Event('scroll'));
  });
  await waitForUI('next page button', () => {
    const button = [...document.querySelectorAll('[role="treegrid"] button')].find(node => /^(?:Load more|加载更多)/.test(node.textContent.trim()));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  });
  await waitForUI('second page has loaded', () => {
    const viewport = document.querySelector('[role="treegrid"] [role="rowgroup"]');
    return viewport?.scrollHeight > 6500;
  });
  await render(() => {
    const viewport = document.querySelector('[role="treegrid"] [role="rowgroup"]');
    viewport.scrollTop = 5200;
    viewport.dispatchEvent(new Event('scroll'));
  });
  await waitForUI('second-page anchor visible', target => [...document.querySelectorAll('[role="row"] [title]')].some(node => node.title === target), path.join(scopeA, 'item-105.txt'));
  await rowAction(path.join(scopeA, 'item-105.txt'), 'inspect');
  await render(() => {
    const viewport = document.querySelector('[role="treegrid"] [role="rowgroup"]');
    viewport.scrollLeft = 100;
    viewport.dispatchEvent(new Event('scroll'));
  });
  await settleUI();
  const remembered = await render(treeUI);
  assert.equal(remembered.location, scopeA);
  assert.ok(remembered.top > 4800);
  assert.ok(remembered.left > 0);
  assert.equal(remembered.activePath, path.join(scopeA, 'item-105.txt'));
  assert.ok(remembered.columns.some(column => ['Logical size', '逻辑大小'].includes(column.text)));
  assert.ok(remembered.columns.some(column => ['Scan status', '扫描状态'].includes(column.text)));
  report.navigationRemembered = remembered;
  await render(startScrollDiagnostics);
  captureNavigationFocus = true;
  await clickButton(['Activity', '操作记录'], 'nav button');
  await clickButton(['File tree', '文件树'], 'nav button');
  captureNavigationFocus = false;
  await waitFor('scope and scroll restored after navigation', async () => {
    const current = await render(treeUI);
    const { rows, columns, ...sample } = current;
    sample.renderedRows = rows.length;
    const samples = report.navigationRestore ??= [];
    if (JSON.stringify(samples.at(-1)) !== JSON.stringify(sample)) {
      samples.push(sample);
      if (samples.length > 12) samples.shift();
    }
    return current.location === scopeA && Math.abs(current.top - remembered.top) <= 50 && current.scrollHeight > 6500;
  });
  await waitFor('active path and horizontal scroll restored', async () => {
    const current = await render(treeUI);
    return current.activePath === remembered.activePath && Math.abs(current.left - remembered.left) <= 1;
  });
  report.navigationScrollMutations = await render(stopScrollDiagnostics);
  const returned = await render(treeUI);
  assert.deepEqual(returned.columns, remembered.columns);
  assert.ok(Math.abs(returned.left - remembered.left) <= 1, 'Horizontal scroll must survive unmounting the tree.');
  assert.equal(returned.activePath, remembered.activePath);
  report.checks.push('File-tree scope, loaded pages, both scroll axes, active path, sorting and optional columns survive page navigation.');

  await render(() => {
    const input = document.querySelector('input[aria-label="Search scanned items"], input[aria-label="搜索已扫描内容"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'item-12');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const select = document.querySelector('select[title="Minimum file size (logical size)"], select[title="最小文件大小（逻辑大小）"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, String(10 * 1024 ** 2));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitForUI('search and size filter result', target => {
    const names = [...document.querySelectorAll('[role="grid"] [role="row"] [title]')].filter(node => node.title === target);
    return names.length > 0;
  }, path.join(scopeA, 'big-item-120.txt'));
  await clickButton(['My files', '我的文件'], 'nav button');
  await waitForUI('separate file-list filter memory', () => {
    const search = document.querySelector('input[aria-label="Search scanned items"], input[aria-label="搜索已扫描内容"]');
    const select = document.querySelector('select[title="Minimum file size (logical size)"], select[title="最小文件大小（逻辑大小）"]');
    return search?.value === '' && select?.value === '0';
  });
  await clickButton(['File tree', '文件树'], 'nav button');
  await waitForUI('tree filters restored independently', () => {
    const search = document.querySelector('input[aria-label="Search scanned items"], input[aria-label="搜索已扫描内容"]');
    const select = document.querySelector('select[title="Minimum file size (logical size)"], select[title="最小文件大小（逻辑大小）"]');
    return search?.value === 'item-12' && select?.value === String(10 * 1024 ** 2);
  });
  report.checks.push('Tree search and logical-size filters survive navigation without leaking into My files.');
  await render(() => {
    const input = document.querySelector('input[aria-label="Search scanned items"], input[aria-label="搜索已扫描内容"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const select = document.querySelector('select[title="Minimum file size (logical size)"], select[title="最小文件大小（逻辑大小）"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, '0');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitForUI('unfiltered directory scope restored', target => document.querySelector('button[aria-current="location"]')?.title === target, scopeA);
  await waitForUI('restored tree finishes loading before user scroll', () => {
    const search = document.querySelector('input[aria-label="Search scanned items"], input[aria-label="搜索已扫描内容"]');
    return search && !search.disabled && ![...document.querySelectorAll('[role="status"]')].some(node => /正在恢复浏览位置|Restoring your location/.test(node.textContent));
  });
  await settleUI();
  await render(() => {
    const viewport = document.querySelector('[role="treegrid"] [role="rowgroup"]');
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
  });
  await rowAction(nested, 'expand');
  const selection = path.join(scopeA, 'item-001.txt');
  await rowAction(selection, 'inspect');
  await rowAction(selection, 'select');
  const oldEntries = await call('resolvePaths', [scopeA, nested, selection], initial.scanId);
  assert.ok(oldEntries.every(Boolean));
  // Root entries are indexed before descendants. Adding root entries ensures
  // the descendant IDs change even when the filesystem preserves enumeration order.
  for (let index = 0; index < 32; index++) await fs.writeFile(path.join(treeRoot, `new-root-${index}.txt`), 'Synthetic ID shift.');
  await clickButton(['Scan again', '重新扫描']);
  const rescanned = await completedScan(initial.scanId);
  await waitForUI('same directory restored by path after rescan', target => document.querySelector('button[aria-current="location"]')?.title === target, scopeA);
  const newEntries = await call('resolvePaths', [scopeA, nested, selection], rescanned.scanId);
  assert.ok(newEntries.every(Boolean));
  assert.notEqual(newEntries[0].id, oldEntries[0].id, 'Fixture must actually replace saved entry IDs.');
  await waitForUI('expanded path restored after ID replacement', target => [...document.querySelectorAll('[role="treegrid"] [role="row"]')].some(row => row.getAttribute('aria-expanded') === 'true' && [...row.querySelectorAll('[title]')].some(node => node.title === target)), nested);
  await waitForUI('active path restored with a new row ID', target => {
    const grid = document.querySelector('[role="treegrid"]');
    const row = document.getElementById(grid?.getAttribute('aria-activedescendant') || '');
    return [...(row?.querySelectorAll('[title]') || [])].some(node => node.title === target);
  }, selection);
  assert.equal(await render(() => document.querySelectorAll('[role="treegrid"] input[type="checkbox"]:checked').length), 0);
  assert.equal(await render(() => [...document.querySelectorAll('button')].some(node => /^(?:Review \d+|查看 \d+ 项)$/.test(node.textContent.trim()))), false);
  await assert.rejects(call('resolvePaths', [scopeA], initial.scanId), /SCAN_CHANGED/);
  report.checks.push('Same-root rescans restore directory and expansion by path after IDs change, while clearing cleanup selections.');

  await fs.rename(scopeA, path.join(projects, 'a-renamed'));
  await clickButton(['Scan again', '重新扫描']);
  const missingScan = await completedScan(rescanned.scanId);
  await waitForUI('missing directory falls back to its nearest existing ancestor', target => document.querySelector('button[aria-current="location"]')?.title === target, projects);
  assert.deepEqual(await call('resolvePaths', [scopeA], missingScan.scanId), [null]);
  assert.equal(await render(() => document.querySelectorAll('[role="treegrid"] input[type="checkbox"]:checked').length), 0);
  report.checks.push('A missing saved directory falls back to its existing parent instead of reusing an unrelated entry ID.');

  const renamedScope = path.join(projects, 'a-renamed');
  await rowAction(renamedScope, 'enter');
  await waitForUI('renamed folder becomes the saved tree location', target => document.querySelector('button[aria-current="location"]')?.title === target, renamedScope);
  await waitForExplorerReady();
  await clickButton(['Overview', '空间概览'], 'nav button');
  await clickButton(['Scan again', '重新扫描']);
  const overviewScan = await completedScan(missingScan.scanId);
  await waitForUI('current overview folder card opens its explicit scope', () => {
    const button = [...document.querySelectorAll('button.folder-row')].find(node => node.querySelector('span')?.textContent.trim() === 'projects');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  });
  await waitForUI('overview card takes precedence over remembered child scope', target => document.querySelector('button[aria-current="location"]')?.title === target, projects);
  report.checks.push('After an overview rescan, a current folder card opens its requested path instead of restoring a remembered child.');

  // Establish a completed file-list view before asking it to accept a later,
  // incomplete scan. Merely mounting the page before loading has no memory yet.
  await clickButton(['My files', '我的文件'], 'nav button');
  await waitForUI('completed file list has established its independent memory', () => {
    const search = document.querySelector('input[aria-label="Search scanned items"], input[aria-label="搜索已扫描内容"]');
    return search && !search.disabled && document.querySelectorAll('[role="grid"] [role="row"] [title]').length > 0;
  });
  await settleUI();
  await clickButton(['File tree', '文件树'], 'nav button');
  await rowAction(renamedScope, 'enter');
  await waitForUI('tree location is remembered before an incomplete rescan', target => document.querySelector('button[aria-current="location"]')?.title === target, renamedScope);
  await waitForExplorerReady();
  await clickButton(['Overview', '空间概览'], 'nav button');
  nextControl = { gatePath: treeRoot };
  await clickButton(['Scan again', '重新扫描']);
  await waitFor('same-root scan remains incomplete at real opendir', () => heldWorker);
  await clickButton(['My files', '我的文件'], 'nav button');
  await clickButton(['Stay in this folder', '留在当前目录']);
  await clickButton(['File tree', '文件树'], 'nav button');
  await waitForUI('tree retains its own pending restore after file-list acceptance', () => [...document.querySelectorAll('[role="status"]')].some(node => /扫描完成后将恢复上次浏览位置|previous location will return when scanning finishes/.test(node.textContent)));
  heldWorker.postMessage({ type: 'navigation-harness-release' });
  heldWorker = null;
  await completedScan(overviewScan.scanId);
  await waitForUI('file-list choice does not discard the tree saved path', target => document.querySelector('button[aria-current="location"]')?.title === target, renamedScope);
  report.checks.push('Accepting the file-list location during an incomplete rescan preserves the tree view’s independent path memory.');
}

async function retryChecks() {
  nextControl = { faultPath: denied };
  const failedScan = await startThroughUI(failureRoot);
  assert.equal(failedScan.errors, 1);
  const issue = failedScan.errorDetails.find(item => item.code === 'EACCES');
  assert.ok(issue, 'Synthetic read failure must be represented in the real scan summary.');
  assert.equal((await call('entry', issue.id)).path, denied);
  await clickButton(['Review read errors', '查看读取问题']);
  await waitForUI('failed scope and explanation', target => {
    const section = document.querySelector('section[aria-label="Read errors"], section[aria-label="读取问题"]');
    return section?.textContent.includes(target) && /替换当前结果|replaces the current results/i.test(section.textContent)
      && [...section.querySelectorAll('button')].some(node => ['Scan this scope again', '重新扫描此范围'].includes(node.textContent.trim()) && !node.disabled);
  }, denied);
  await clickButton(['Scan this scope again', '重新扫描此范围'], 'section[aria-label] button');
  const recovered = await completedScan(failedScan.scanId);
  assert.equal(recovered.rootPath, denied);
  assert.equal(recovered.errors, 0);
  assert.equal(recovered.files, 1);
  const files = (await call('query', { kind: 'file' })).entries;
  assert.deepEqual(files.map(item => item.path), [path.join(denied, 'recoverable.txt')]);
  assert.equal(createdWorkers.at(-1).rootPath, denied);
  await assert.rejects(call('retryScan', issue.id, failedScan.scanId), /SCAN_CHANGED/);
  report.checks.push('Read-error UI retries only the failed scope with a fresh scan and rejects stale retry IDs.');
}

async function execute() {
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(app.commandLine.hasSwitch('no-sandbox'), false);
  assert.match(window.webContents.getURL(), /^diskharbor:\/\/app\//);
  assert.equal(await call('summary'), null);
  report.checks.push('Isolated production renderer starts without scanning and keeps its sandbox.');
  const cancelledScanId = await cancellationChecks();
  await navigationChecks(cancelledScanId);
  await retryChecks();
  assert.deepEqual(report.errors, []);
}

try {
  for (const directory of [cancelRoot, lateReplyRoot, nested, path.join(projects, 'b'), denied, userData, process.env.XDG_DATA_HOME]) fsSync.mkdirSync(directory, { recursive: true });
  fsSync.writeFileSync(path.join(cancelRoot, 'retained.txt'), 'Synthetic cancellation fixture.');
  fsSync.writeFileSync(path.join(lateReplyRoot, 'new-scan.txt'), 'Synthetic late-reply fixture.');
  fsSync.writeFileSync(path.join(nested, 'nested-leaf.txt'), 'Nested navigation fixture.');
  fsSync.writeFileSync(path.join(denied, 'recoverable.txt'), 'Synthetic failure fixture.');
  fsSync.writeFileSync(path.join(failureRoot, 'outside-scope.txt'), 'Must not be included by scope retry.');
  for (let index = 0; index < 135; index++) fsSync.writeFileSync(path.join(scopeA, `item-${String(index).padStart(3, '0')}.txt`), `Navigation fixture ${index}.`);
  fsSync.writeFileSync(path.join(scopeA, 'big-item-120.txt'), 'Synthetic sparse size-filter fixture.');
  fsSync.truncateSync(path.join(scopeA, 'big-item-120.txt'), 11 * 1024 ** 2);
  fsSync.writeFileSync(bootstrap, `
'use strict';
const fs = require('node:fs/promises');
const { parentPort, workerData } = require('node:worker_threads');
const control = workerData.navigationHarness;
const original = fs.opendir;
let release;
const gate = new Promise(resolve => { release = resolve; });
parentPort.on('message', message => { if (message?.type === 'navigation-harness-release') release(); });
fs.opendir = async function (target, ...args) {
  const value = Buffer.isBuffer(target) ? target.toString('utf8') : String(target);
  if (value === control.gatePath) {
    parentPort.postMessage({ type: 'navigation-harness-gated' });
    await gate;
  }
  if (value === control.faultPath) throw Object.assign(new Error('Synthetic fixture permission failure.'), { code: 'EACCES' });
  return original.call(this, target, ...args);
};
require(control.entry);
`);
  app.on('browser-window-created', (_event, created) => {
    if (window) return;
    window = created;
    window.webContents.on('console-message', (_event, details) => {
      if (details.level === 'error') report.errors.push(details.message);
    });
    window.webContents.once('did-finish-load', () => {
      ipcMain.handle = originalHandle;
      execute().then(() => finish(), finish);
    });
  });
  require('../electron/main.cjs');
} catch (error) { void finish(error); }
