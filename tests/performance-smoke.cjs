'use strict';

const { app, ipcMain, screen } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const workerThreads = require('node:worker_threads');
const { percentile } = require('./performance-fixtures.cjs');
const { installRendererDiagnostics } = require('./performance-diagnostics.cjs');
const diagnosticsEnabled = process.env.DISKHARBOR_PERFORMANCE_DIAGNOSTICS === '1';
const diagnostics = { mode: 'Diagnostic instrumentation adds overhead; not a release benchmark.', mainEvents: [] };
const base = process.env.DISKHARBOR_PERFORMANCE_SMOKE_DIR;
const fixture = process.env.DISKHARBOR_PERFORMANCE_FIXTURE_DIR;
assert.ok(base && path.isAbsolute(base) && path.basename(base).startsWith('performance-smoke-'));
assert.ok(fixture && path.isAbsolute(fixture) && path.basename(fixture).startsWith('performance-'));
const realRoot = path.join(fixture, 'real-100k');
const millionRoot = path.join(fixture, 'synthetic-million');
const bootstrap = path.join(base, 'synthetic-worker.cjs');
const report = { platform: process.platform, startedAt: new Date().toISOString(), budgets: { interactionP95Ms: 200, millionAppPeakBytes: 1.5 * 1024 ** 3 }, checks: [], errors: [], limitations: ['No manual screen-reader listening test.', 'Warm filesystem metadata; benchmark hardware is recorded, not a controlled 4-core/8-GiB machine.', 'Summed process working sets conservatively double-count shared pages.'] };
let window, finished = false, phase = 'startup', memoryTimer;
const memory = [];
const queries = [];
const originalHandle = ipcMain.handle;
ipcMain.handle = function(channel, listener) {
  if (channel !== 'diskharbor:query' && !diagnosticsEnabled) return originalHandle.call(this, channel, listener);
  return originalHandle.call(this, channel, async (event, ...args) => {
    const start = performance.now();
    try {
      const response = await listener(event, ...args);
      if (channel === 'diskharbor:query') queries.push({ phase, query: args[0], elapsedMs: performance.now() - start, firstId: response?.entries?.[0]?.id, total: response?.total });
      return response;
    } finally {
      if (diagnosticsEnabled && diagnostics.mainEvents.length < 10000) diagnostics.mainEvents.push({
        kind: 'ipc', phase, channel, startedAtEpochMs: performance.timeOrigin + start, durationMs: performance.now() - start,
      });
    }
  });
};
const NativeWorker = workerThreads.Worker;
workerThreads.Worker = class PerformanceWorker extends NativeWorker {
  constructor(filename, options) {
    if (path.basename(String(filename)) === 'scan-worker.cjs') {
      (report.workerSources ??= []).push({ root: options.workerData.rootPath, at: new Date().toISOString(), scannerSHA256: createHash('sha256').update(fsSync.readFileSync(path.resolve(__dirname, '../electron/scanner.cjs'))).digest('hex') });
    }
    const synthetic = path.basename(String(filename)) === 'scan-worker.cjs' && options?.workerData?.rootPath === millionRoot;
    super(synthetic ? bootstrap : filename, synthetic ? { ...options, workerData: { ...options.workerData, performanceEntry: String(filename) } } : options);
    if (diagnosticsEnabled) this.on('message', message => {
      if (message?.summary && diagnostics.mainEvents.length < 10000) diagnostics.mainEvents.push({
        kind: 'worker-progress', phase, atEpochMs: performance.timeOrigin + performance.now(),
        state: message.summary.state, files: message.summary.files,
      });
    });
  }
};
app.setPath('userData', path.join(base, 'user-data'));
app.setPath('sessionData', path.join(base, 'session'));
// Keep production GPU policy: software-only flags distort the application budget.
const watchdog = setTimeout(() => finish(new Error('Performance harness timed out after 15 minutes.')), 15 * 60 * 1000);
function render(fn, ...args) { return window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`); }
function call(method, ...args) { return render((name, values) => window.diskharbor[name](...values), method, args); }
async function waitFor(description, read, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Performance wait failed: ${description}`);
}
async function click(names, selector = 'button') {
  return waitFor(names.join('/'), () => render((labels, scope) => {
    const node = [...document.querySelectorAll(scope)].find(node => labels.includes(node.textContent.trim()) || labels.includes(node.getAttribute('aria-label')));
    if (!node || node.disabled || !node.getClientRects().length) return false;
    node.focus(); node.click(); return true;
  }, names, selector));
}
async function ready() { return waitFor('explorer ready', () => render(() => {
  const grid = document.querySelector('.fx-table');
  return grid && grid.getAttribute('aria-busy') !== 'true' && document.querySelectorAll('.fx-row').length && !document.querySelector('.fx-search input')?.disabled;
})); }
async function frames() { return render(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function foregroundState(label) {
  return { label, phase, at: new Date().toISOString(), visible: window.isVisible(), focused: window.isFocused(),
    ...await render(() => ({ visibilityState: document.visibilityState, documentHasFocus: document.hasFocus() })) };
}
async function recordForeground(label) {
  const state = await foregroundState(label);
  (report.foreground ??= []).push(state);
  assert.ok(state.visible && state.focused && state.visibilityState === 'visible' && state.documentHasFocus,
    `FOREGROUND_REQUIRED: ${JSON.stringify(state)}`);
  return state;
}
async function key(value, modifiers = []) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: value, modifiers });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: value, modifiers });
  await frames();
}
function geometry() {
  const grid = document.querySelector('.fx-table'); const viewport = document.querySelector('.fx-viewport');
  const id = grid?.getAttribute('aria-activedescendant'); const active = id ? document.getElementById(id) : null;
  const a = active?.getBoundingClientRect(), v = viewport?.getBoundingClientRect();
  return { activeId: id, activeText: active?.textContent, activeLevel: active?.getAttribute('aria-level'), activeExpanded: active?.getAttribute('aria-expanded'), activeSelected: active?.getAttribute('aria-selected'), activeVisible: !!a && !!v && a.top >= v.top - 1 && a.bottom <= v.bottom + 1, activeInWindow: !!a && a.top >= 0 && a.bottom <= innerHeight, activeRect: a ? { top: a.top, bottom: a.bottom } : null, windowHeight: innerHeight, documentTop: document.scrollingElement?.scrollTop, gridRect: grid ? { top: grid.getBoundingClientRect().top, bottom: grid.getBoundingClientRect().bottom, cssHeight: getComputedStyle(grid).height, flex: getComputedStyle(grid).flex } : null, viewportRect: v ? { top: v.top, bottom: v.bottom, height: v.height, cssHeight: getComputedStyle(viewport).height, flex: getComputedStyle(viewport).flex } : null, top: viewport?.scrollTop, height: viewport?.scrollHeight, client: viewport?.clientHeight, renderedRows: document.querySelectorAll('.fx-row').length, activeRole: active?.getAttribute('role'), described: !!document.getElementById(grid?.getAttribute('aria-describedby')), bodyWidth: document.body.scrollWidth, viewportWidth: innerWidth, gridFocused: document.activeElement === grid };
}
function recordMemory() {
  if (!app.isReady()) return;
  const processes = app.getAppMetrics().map(item => ({ pid: item.pid, type: item.type, workingSetBytes: item.memory.workingSetSize * 1024, peakWorkingSetBytes: item.memory.peakWorkingSetSize * 1024 }));
  memory.push({ phase, at: Date.now(), total: processes.reduce((sum, item) => sum + item.workingSetBytes, 0), processes });
}
async function timedUI(label, column, expected) {
  const before = queries.length;
  const probeStart = performance.now(); await render(() => true);
  const ipcProbeMs = performance.now() - probeStart;
  const start = performance.now();
  const measured = await render(async (columnIndex, expectedNames, diagnostic) => {
    if (document.visibilityState !== 'visible' || !document.hasFocus()) throw new Error('FOREGROUND_REQUIRED: sort action');
    const header = document.querySelectorAll('.fx-header [role="columnheader"]')[columnIndex];
    const oldDirection = header.getAttribute('aria-sort');
    const direction = oldDirection === 'ascending' ? 'descending' : oldDirection === 'descending' ? 'ascending' : columnIndex === 1 ? 'ascending' : 'descending';
    const expectedFirst = expectedNames[direction];
    const grid = document.querySelector('.fx-table');
    let transitioned = false;
    const observer = new MutationObserver(records => {
      if (records.some(record => (record.attributeName === 'aria-busy' && record.target.getAttribute('aria-busy') === 'true') || (record.type === 'childList' && record.target.closest?.('.fx-viewport')))) transitioned = true;
    });
    observer.observe(grid, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy'] });
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const probe = diagnostic ? window.__diskharborPerformanceProbe : null;
    probe?.begin('sort', columnIndex);
    const started = performance.now(); header.querySelector('button').click(); probe?.afterClick();
    await frame(); await frame();
    const feedbackMs = performance.now() - started;
    let stable = 0, previous = null;
    try {
      while (performance.now() - started < 10000) {
        const first = document.querySelector('.fx-row .fx-filename')?.textContent;
        const sort = document.querySelectorAll('.fx-header [role="columnheader"]')[columnIndex]?.getAttribute('aria-sort');
        const busy = document.querySelector('.fx-table')?.getAttribute('aria-busy');
        const signature = `${sort}|${first}|${document.querySelectorAll('.fx-row').length}|${document.querySelector('.fx-virtual-space')?.style.height}`;
        const complete = transitioned && sort === direction && busy === 'false' && !document.querySelector('.fx-search input')?.disabled && first === expectedFirst;
        stable = complete && signature === previous ? stable + 1 : 0; previous = signature;
        if (stable >= 2) return { feedbackMs, completionMs: performance.now() - started, expectedFirst, direction, transitioned,
          ...(probe ? { diagnostic: probe.finish() } : {}) };
        await frame();
      }
      throw new Error(`Sort DOM did not settle: ${JSON.stringify({ columnIndex, direction, expectedFirst, transitioned, previous })}`);
    } finally { observer.disconnect(); }
  }, column, expected, diagnosticsEnabled);
  const rendererRoundTripMs = performance.now() - start;
  assert.equal(queries.length - before, 1, `A settled sort must issue exactly one production query: ${label}`);
  return { label, ...measured, ipcProbeMs, rendererRoundTripMs, transportAndSchedulingMs: Math.max(0, rendererRoundTripMs - measured.completionMs), queries: queries.slice(before).map(({ elapsedMs, query }) => ({ elapsedMs, query })) };
}
async function scan(target, expectedFiles) {
  const start = performance.now();
  const pending = call('startScan', target);
  await pending;
  const summary = await waitFor('scan completed', async () => {
    const summary = await call('summary');
    if (summary?.state === 'error') { report.scanFailure = summary; throw new Error(summary.message || 'Scan failed.'); }
    return summary?.state === 'completed' && summary.rootPath === target ? summary : false;
  }, 240000);
  assert.equal(summary.files, expectedFiles); assert.equal(summary.errors, 0); assert.equal(summary.skipped, 0);
  return { summary, elapsedMs: performance.now() - start };
}
async function execute() {
  if (diagnosticsEnabled) {
    report.measurementMode = diagnostics.mode;
    diagnostics.renderer = await render(installRendererDiagnostics);
    diagnostics.displays = screen.getAllDisplays().map(display => ({ bounds: display.bounds, scaleFactor: display.scaleFactor, displayFrequency: display.displayFrequency }));
  }
  window.setSize(1320, 860); await window.webContents.setZoomFactor(1);
  const visibleStarted = performance.now();
  // A physical user click activates its window; a DOM click does not. Require
  // that same foreground precondition without changing production throttling.
  window.show(); app.focus({ steal: true }); window.focus();
  await waitFor('visible focused production window before user interactions', async () => {
    const state = await foregroundState('startup'); report.foregroundStartup = state;
    return state.visible && state.focused && state.visibilityState === 'visible' && state.documentHasFocus;
  });
  await recordForeground('startup confirmed');
  await frames();
  report.initialVisibleWaitMs = performance.now() - visibleStarted;
  report.foregroundRequirement = 'Visible focused native window and foreground document before measurements; no warm-up delay, disabled throttling or discarded samples.';
  report.graphics = app.getGPUFeatureStatus();
  report.security = window.webContents.getLastWebPreferences();
  assert.equal(report.security.sandbox, true); assert.equal(report.security.nodeIntegration, false);
  report.security = { sandbox: true, nodeIntegration: false, contextIsolation: report.security.contextIsolation };
  memoryTimer = setInterval(recordMemory, 100); recordMemory();
  report.build = { packageVersion: require('../package.json').version,
    htmlSHA256: createHash('sha256').update(fsSync.readFileSync(path.resolve(__dirname, '../dist/index.html'))).digest('hex'),
    assets: await render(() => [...document.querySelectorAll('script[src],link[rel="stylesheet"]')].map(node => node.src || node.href)) };
  phase = 'real-100k-cancel';
  await recordForeground('cancellation phase begins');
  // Synchronous process-metric collection is outside timed interaction phases.
  // Whole-application memory keeps its independent continuous 100 ms phase.
  clearInterval(memoryTimer); recordMemory();
  await call('startScan', realRoot);
  await waitFor('nonempty partial 100k scan', async () => {
    const value = await call('summary');
    if (value?.state === 'completed') throw new Error('Cancellation fixture finished before the stop test could run.');
    return value?.state === 'scanning' && value.files >= 100;
  });
  await waitFor('enabled stop button', () => render(() => [...document.querySelectorAll('button')].some(node => /^(Stop scan|停止扫描)$/.test(node.textContent.trim()) && !node.disabled)));
  await recordForeground('before stop click');
  const cancelStarted = performance.now();
  const cancelPaint = await render(async diagnostic => {
    if (document.visibilityState !== 'visible' || !document.hasFocus()) throw new Error('FOREGROUND_REQUIRED: stop action');
    const button = [...document.querySelectorAll('button')].find(node => /^(Stop scan|停止扫描)$/.test(node.textContent.trim()));
    const probe = diagnostic ? window.__diskharborPerformanceProbe : null;
    probe?.begin('cancel');
    const start = performance.now(); button.click(); probe?.afterClick();
    let firstFrameMs, statusAtFirstFrame;
    await new Promise(resolve => requestAnimationFrame(() => {
      firstFrameMs = performance.now() - start;
      statusAtFirstFrame = document.querySelector('.scan-status')?.textContent ?? null;
      requestAnimationFrame(resolve);
    }));
    return { feedbackMs: performance.now() - start, firstFrameMs, statusAtFirstFrame,
      statusAtSecondFrame: document.querySelector('.scan-status')?.textContent ?? null,
      visibilityState: document.visibilityState, documentHasFocus: document.hasFocus(),
      ...(probe ? { diagnostic: probe.finish() } : {}) };
  }, diagnosticsEnabled);
  const cancelled = await waitFor('cancelled partial scan', async () => {
    const value = await call('summary'); return value?.state === 'cancelled' ? value : false;
  }, 5000);
  report.cancellation = { ...cancelPaint, settledMs: performance.now() - cancelStarted, retainedFiles: cancelled.files, state: cancelled.state };
  await recordForeground('after stop measurement');
  assert.ok(cancelled.files > 0 && cancelled.files < 100129);
  report.cancellation.passed = report.cancellation.feedbackMs <= 1000 && report.cancellation.settledMs <= 3000;
  if (!diagnosticsEnabled) assert.ok(report.cancellation.passed, 'Cancellation must meet the unchanged 1s feedback / 3s local-I/O budget');
  if (report.cancellation.passed) report.checks.push('100k scan cancellation retains partial results and meets 1s feedback / 3s settlement');
  phase = 'real-100k-scan';
  await recordForeground('complete real scan begins');
  recordMemory(); memoryTimer = setInterval(recordMemory, 100);
  report.realScan = await scan(realRoot, 100129);
  await click(['File tree', '文件树']); await ready(); await frames();
  const first = await render(geometry); assert.ok(first.renderedRows < 100, 'Only virtual rows may mount');
  report.checks.push('100,000 real sibling files retained; virtual DOM remains bounded');
  phase = 'real-100k-interactions';
  await recordForeground('real tree interactions begin');
  clearInterval(memoryTimer); recordMemory();
  const operations = [];
  // Determine fixture expectations without priming any query/sort cache. Every
  // sibling file is empty, so these two directories and the two name extremes
  // cover the first row for all measured sorts, including unknown allocation.
  const candidates = await call('resolvePaths', ['000-branch', '001-deep', 'file-000000.txt', 'file-099999.txt'].map(name => path.join(realRoot, name)), report.realScan.summary.scanId);
  // Unknown allocations retain discovery-id order; include its first child
  // instead of assuming any filesystem enumerates names lexically.
  const firstDiscovered = await call('entry', report.realScan.summary.rootId + 1);
  assert.equal(firstDiscovered.parentId, report.realScan.summary.rootId);
  candidates.push(firstDiscovered);
  assert.ok(candidates.every(Boolean));
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const expected = Object.fromEntries([[1, 'name'], [2, 'allocatedSize'], [5, 'logicalSize']].map(([column, key]) => [column,
    Object.fromEntries([['ascending', 1], ['descending', -1]].map(([name, direction]) => [name, [...candidates].sort((a, b) => {
      if (a[key] === null || b[key] === null) return a[key] === b[key] ? a.id - b.id : a[key] === null ? 1 : -1;
      return (key === 'name' ? collator.compare(a[key], b[key]) : a[key] - b[key]) * direction || collator.compare(a.name, b.name);
    })[0].name]))]));
  await click(['Columns', '显示列']);
  await render(() => { const box = document.querySelector('.fx-column-menu input'); if (box) { if (!box.checked) box.click(); box.focus(); } });
  await key('Escape');
  assert.equal(await render(() => document.activeElement?.getAttribute('aria-controls') === document.querySelector('.fx-column-control button')?.getAttribute('aria-controls')), true);
  for (let round = 0; round < 20; round++) {
    for (const column of [1, 2, 5]) {
      operations.push(await timedUI(`sort-${column}-${round}`, column, expected[column]));
    }
  }
  // Name ascending puts the branch first; sorting is an explicit DOM action.
  await render(() => { const h = document.querySelectorAll('.fx-header [role="columnheader"]')[1]; if (h.getAttribute('aria-sort') !== 'ascending') h.querySelector('button').click(); });
  await ready(); await frames();
  for (let round = 0; round < 12; round++) {
    const started = performance.now();
    const latency = await render(async () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) throw new Error('FOREGROUND_REQUIRED: expand action');
      const button = document.querySelector('.fx-expand'); const start = performance.now(); button.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return performance.now() - start;
    });
    await ready(); await frames();
    operations.push({ label: `expand-collapse-${round}`, feedbackMs: latency, completionMs: performance.now() - started });
  }
  report.interactions = { method: 'Fixed 60 sort samples on every platform; renderer DOM expected direction/first row/nonbusy plus two stable frames. Expand/collapse timing includes renderer round trip. Nearest-rank p95; all samples and maxima retained.', memorySampling: 'Boundary samples during timed UI; continuous 100 ms whole-application sampling during scans and the 1M phase.', samples: operations, feedbackP95Ms: percentile(operations.map(x => x.feedbackMs), .95), completionP95Ms: percentile(operations.map(x => x.completionMs), .95) };
  report.interactions.groups = Object.fromEntries(['sort', 'expand-collapse'].map(prefix => {
    const samples = operations.filter(item => item.label.startsWith(prefix));
    return [prefix, { count: samples.length, feedbackP95Ms: percentile(samples.map(item => item.feedbackMs), .95), completionP95Ms: percentile(samples.map(item => item.completionMs), .95), feedbackMaxMs: Math.max(...samples.map(item => item.feedbackMs)), completionMaxMs: Math.max(...samples.map(item => item.completionMs)) }];
  }));
  report.interactions.feedbackPassed = Object.values(report.interactions.groups).every(group => group.feedbackP95Ms <= 200);
  report.interactions.completionPassed = Object.values(report.interactions.groups).every(group => group.completionP95Ms <= 200);
  report.checks.push('Measured sorting and expand/collapse feedback and completion separately');
  await recordForeground('after timed interactions, before keyboard checks');
  await render(() => document.querySelector('.fx-table').focus());
  await key('Home'); let state = await render(geometry); assert.ok(state.activeVisible && state.activeRole === 'row' && state.described);
  await key('Right'); await ready(); await frames(); state = await render(geometry); assert.equal(state.activeExpanded, 'true');
  await key('Right'); state = await render(geometry); assert.equal(state.activeLevel, '2');
  await key('Left'); state = await render(geometry); assert.equal(state.activeLevel, '1');
  await key('Left'); state = await render(geometry); assert.equal(state.activeExpanded, 'false');
  await key('Down'); await key('Down'); await key('Space'); state = await render(geometry); assert.equal(state.activeSelected, 'true');
  await key('Space'); state = await render(geometry); assert.equal(state.activeSelected, 'false');
  await key('End'); state = await render(geometry); assert.ok(state.activeVisible && /Load more|加载更多/.test(state.activeText));
  await key('Return'); await ready(); await frames();
  assert.ok(await render(() => Number(document.querySelector('.fx-footer')?.textContent.match(/[\d,]+/)?.[0].replaceAll(',', '')) >= 200));
  await key('Home'); await key('PageDown'); state = await render(geometry); assert.ok(state.activeVisible && state.top > 0);
  await key('PageUp'); await key('Home'); state = await render(geometry); assert.equal(state.top, 0);
  report.keyboard = state; report.checks.push('Home/End/Page keys, hierarchy, selection and keyboard pagination preserve visible ARIA focus');
  await window.webContents.debugger.attach('1.3');
  const ax = await window.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
  report.accessibility = { treegrid: ax.nodes.filter(node => node.role?.value === 'treegrid').map(node => ({ name: node.name?.value, properties: node.properties })), rowCount: ax.nodes.filter(node => node.role?.value === 'row').length, screenReaderListening: 'not-verified' };
  assert.ok(report.accessibility.treegrid.length); window.webContents.debugger.detach();
  report.checks.push('Chromium accessibility tree exposes named treegrid and rows; listening remains unverified');
  await recordForeground('before zoom checks');
  window.setSize(1024, 700); window.webContents.setZoomFactor(2); await frames();
  await render(() => document.querySelector('.fx-table').focus()); await key('End');
  report.zoom200 = await render(geometry);
  report.zoom200.pageFits = report.zoom200.bodyWidth <= report.zoom200.viewportWidth;
  assert.ok(report.zoom200.activeVisible && report.zoom200.activeInWindow, 'At 200% focused row must remain visible in both the internal viewport and the window');
  await fs.writeFile(path.join(base, 'tree-200-percent.png'), (await window.webContents.capturePage()).toPNG());
  await click(['切换为英文', 'Switch to English']); await frames();
  await render(() => document.querySelector('.fx-table').focus()); await key('Home'); await key('End');
  report.zoom200English = await render(geometry);
  assert.ok(report.zoom200English.activeVisible && report.zoom200English.activeInWindow);
  assert.ok(report.zoom200English.bodyWidth <= report.zoom200English.viewportWidth);
  assert.equal(await render(() => document.querySelector('.fx-table')?.getAttribute('aria-label')), 'File tree');
  await fs.writeFile(path.join(base, 'tree-200-percent-en.png'), (await window.webContents.capturePage()).toPNG());
  await recordForeground('after both zoom checks');
  report.checks.push('Chinese and English 200% tree keyboard interaction at 1024×700 preserves actual visible focus without page overflow');
  window.webContents.setZoomFactor(1); window.setSize(1320, 860); await frames();
  console.log('100k/keyboard/zoom phases finished; beginning 1M full-application measurement.');
  await fs.writeFile(path.join(base, 'partial-report.json'), JSON.stringify(report, null, 2));
  phase = 'million-synthetic-scan';
  await recordForeground('million scan begins');
  recordMemory(); memoryTimer = setInterval(recordMemory, 100);
  report.millionScan = await scan(millionRoot, 1000000);
  await ready(); await frames();
  phase = 'million-synthetic-query';
  await recordForeground('million queries begin');
  for (const sortBy of ['name', 'allocatedSize', 'logicalSize', 'modifiedAt']) {
    const result = await call('query', { parentId: report.millionScan.summary.rootId, sortBy, sortDirection: 'desc', limit: 100, includeHidden: false, includeSystem: false });
    assert.equal(result.total, 1000000); assert.equal(result.entries.length, 100);
    const last = await call('query', { parentId: report.millionScan.summary.rootId, sortBy, sortDirection: 'desc', offset: 999999, limit: 100 });
    assert.equal(last.entries.length, 1); recordMemory();
  }
  report.millionRetained = (await call('summary')).files;
  await recordForeground('million queries complete');
  assert.equal(report.millionRetained, 1000000);
  recordMemory();
  const millionMemory = memory.filter(item => item.phase.startsWith('million'));
  report.memory = { samplingMs: 100, peakAppBytes: Math.max(...millionMemory.map(item => item.total)), peaksByPhase: Object.fromEntries([...new Set(memory.map(x => x.phase))].map(name => [name, Math.max(...memory.filter(x => x.phase === name).map(x => x.total))])) };
  const processPeaks = new Map();
  for (const sample of millionMemory) for (const item of sample.processes) processPeaks.set(item.pid, Math.max(processPeaks.get(item.pid) || 0, item.peakWorkingSetBytes));
  report.memory.sumLifetimeProcessPeaksBytes = [...processPeaks.values()].reduce((total, value) => total + value, 0);
  report.memory.lifetimePeakNote = 'Upper bound from independent process lifetime high-water marks, not necessarily simultaneous; includes earlier phases.';
  report.memory.passed = report.memory.peakAppBytes <= report.budgets.millionAppPeakBytes;

  report.checks.push('1,000,000 complete synthetic records retained in production worker/renderer; whole-app memory sampled');
  await fs.writeFile(path.join(base, 'memory.json'), JSON.stringify(memory, null, 2));
  await fs.writeFile(path.join(base, 'queries.json'), JSON.stringify(queries, null, 2));
  report.budgetPassed = report.cancellation.passed && report.interactions.feedbackPassed && report.interactions.completionPassed && report.memory.passed && report.zoom200.pageFits;
}
async function finish(error) {
  if (finished) return; finished = true;
  clearTimeout(watchdog); clearInterval(memoryTimer);
  ipcMain.handle = originalHandle; workerThreads.Worker = NativeWorker;
  if (window && !window.isDestroyed()) report.foregroundAtFinish = await foregroundState('finish').catch(() => null);
  if (error) { report.error = String(error.stack || error); if (window && !window.isDestroyed()) { report.ui = await render(geometry).catch(() => null); await fs.writeFile(path.join(base, 'failure.png'), (await window.webContents.capturePage()).toPNG()); } }
  report.result = error ? 'failed' : report.budgetPassed ? 'passed' : 'budget-not-met';
  if (diagnosticsEnabled) {
    diagnostics.unfinishedAction = await render(() => window.__diskharborPerformanceProbe?.finish()).catch(() => null);
    await fs.writeFile(path.join(base, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(base, 'memory.json'), JSON.stringify(memory, null, 2));
  await fs.writeFile(path.join(base, 'queries.json'), JSON.stringify(queries, null, 2));
  await fs.writeFile(path.join(base, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: path.join(base, 'report.json'), result: report.result, checks: report.checks, error: report.error, interactions: report.interactions && { feedbackP95Ms: report.interactions.feedbackP95Ms, completionP95Ms: report.interactions.completionP95Ms }, memory: report.memory, zoom200: report.zoom200, errors: report.errors }, null, 2));
  app.exit(report.result === 'passed' ? 0 : 1);
}
fsSync.writeFileSync(bootstrap, `'use strict';\nconst {workerData}=require('node:worker_threads');\nconst {ScanIndex}=require(${JSON.stringify(path.resolve(__dirname, '../electron/scanner.cjs'))});\nconst {populateSyntheticIndex}=require(${JSON.stringify(path.resolve(__dirname, 'performance-fixtures.cjs'))});\nScanIndex.prototype.scan=function(){return populateSyntheticIndex(this,1000000)};\nrequire(workerData.performanceEntry);\n`);
app.on('browser-window-created', (_event, created) => {
  if (window) return; window = created;
  window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') report.errors.push(details.message); });
  window.webContents.once('did-finish-load', () => execute().then(() => finish(), finish));
});
require('../electron/main.cjs');
