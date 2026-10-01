'use strict';

// Production renderer, preload, IPC and scanner on disposable directories.
// The initial scenario uses real statfs. Explicitly labelled synthetic cases
// replace statfs numbers only inside a test worker for their own fixture roots.
const { app, ipcMain, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const workerThreads = require('node:worker_threads');

const base = process.env.DISKHARBOR_SPACE_SMOKE_DIR;
assert.ok(base && path.isAbsolute(base) && path.basename(base).startsWith('space-smoke-'));
const firstRoot = path.join(base, 'real-volume-scope');
const secondRoot = path.join(base, 'second-scope');
const identityRoot = path.join(base, 'identity-scope');
const identityOriginal = path.join(base, 'identity-original');
const identityReplacement = path.join(base, 'identity-replacement');
const userData = path.join(base, 'user-data');
const bootstrap = path.join(base, 'worker-bootstrap.cjs');
const scenarios = [
  { name: 'positive', baselineFree: 400, currentFree: 500, total: 1000, comparison: 'comparable', delta: 100 * 4096 },
  { name: 'negative', baselineFree: 400, currentFree: 300, total: 1000, comparison: 'comparable', delta: -100 * 4096 },
  { name: 'zero', baselineFree: 400, currentFree: 400, total: 1000, comparison: 'comparable', delta: 0 },
  { name: 'baseline-unavailable', baselineFree: null, currentFree: 500, total: 1000, comparison: 'baseline-unavailable', delta: null },
  { name: 'volume-changed', baselineFree: 400, currentFree: 500, total: 1000, currentTotal: 2000, comparison: 'volume-changed', delta: null },
].map(value => ({ ...value, rootPath: path.join(base, `synthetic-${value.name}`) }));
const blockedScenario = {
  name: 'blocked-read', rootPath: path.join(base, 'synthetic-blocked-read'),
  baselineFree: 400, currentFree: 500, total: 1000, gateCalls: [2, 4],
};
const workerScenarios = [...scenarios, blockedScenario];
const report = { platform: process.platform, checks: [], errors: [] };
const originalTrash = shell.trashItem;
const originalHandle = ipcMain.handle;
const NativeWorker = workerThreads.Worker;
const measurementCalls = [];
const workerMeasurements = [];
const measurementResponses = [];
const heldMeasurements = new Map();
let window;
let finishing = false;
let trashCalls = 0;

shell.trashItem = async function () {
  trashCalls += 1;
  throw new Error('Space verification must never call the system Trash API.');
};
// Observe real IPC without changing arguments, timing, results or errors.
ipcMain.handle = function (channel, listener) {
  return originalHandle.call(this, channel, channel === 'diskharbor:measureSpace' ? async (event, ...args) => {
    const record = { args };
    measurementCalls.push(record);
    try {
      const result = await listener(event, ...args);
      record.result = result;
      return result;
    } catch (error) {
      record.error = String(error.message || error);
      throw error;
    }
  } : listener);
};
workerThreads.Worker = class SpaceWorker extends NativeWorker {
  constructor(filename, options) {
    const scanWorker = path.basename(String(filename)) === 'scan-worker.cjs';
    const scenario = scanWorker ? workerScenarios.find(value => value.rootPath === options?.workerData?.rootPath) : null;
    super(scenario ? bootstrap : filename, scenario ? {
      ...options, workerData: { ...options.workerData, spaceHarness: { entry: String(filename), scenario } },
    } : options);
    if (scanWorker) this.on('message', message => {
      if (message?.type === 'space-harness-statfs') workerMeasurements.push(message);
      if (message?.type === 'space-harness-gated') heldMeasurements.set(message.callNumber, this);
      if (scenario && message?.type === 'response' && message.result?.current) measurementResponses.push({ name: scenario.name, result: message.result });
    });
  }
};
app.setPath('userData', userData);
app.setPath('sessionData', path.join(userData, 'session'));
app.commandLine.appendSwitch('disable-gpu');
const watchdog = setTimeout(() => finish(new Error('Space verification desktop smoke timed out.')), 120000);

async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  shell.trashItem = originalTrash;
  ipcMain.handle = originalHandle;
  workerThreads.Worker = NativeWorker;
  for (const [callNumber, worker] of heldMeasurements) {
    try { worker.postMessage({ type: 'space-harness-release', callNumber }); } catch { /* A replaced worker may already be gone. */ }
  }
  report.result = error ? 'failed' : 'passed';
  if (error) {
    report.error = String(error.stack || error);
    report.measurementCalls = measurementCalls;
    report.workerMeasurements = workerMeasurements;
    if (window && !window.isDestroyed()) {
      report.ui = await render(spaceUI).catch(() => null);
      report.failureSummary = await call('summary').catch(() => null);
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
  throw new Error(`Space smoke wait failed: ${description}`);
}
function waitForUI(description, read, ...args) {
  return waitFor(description, () => render(read, ...args));
}
async function settleUI() {
  await render(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function clickButton(labels, selector = 'button') {
  await waitForUI(`button ${labels.join(' / ')}`, (names, scope) => {
    const button = [...document.querySelectorAll(scope)].find(node => names.includes(node.textContent.trim())
      || names.includes(node.getAttribute('aria-label'))
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
  const summary = await waitFor('new completed scan', async () => {
    let value;
    try { value = await call('summary'); }
    catch (error) {
      if (/(?:^|:\s*)(?:SCAN_REPLACED|NO_SCAN)$/.test(String(error?.message || error))) return false;
      throw error;
    }
    if (value?.state === 'error') throw new Error(value.message || 'Scan failed.');
    return value?.state === 'completed' && value.scanId !== previous?.scanId ? value : false;
  });
  await waitForUI('current scan reaches the renderer', target => {
    const location = document.querySelector('.scan-toolbar input');
    const scanButton = [...document.querySelectorAll('section[aria-label="Scan location"] button, section[aria-label="扫描位置"] button')]
      .find(button => ['Scan again', '重新扫描'].includes(button.textContent.trim()));
    return location?.value === target && scanButton && !scanButton.disabled;
  }, target);
  return summary;
}
function spaceUI() {
  const section = document.querySelector('section[aria-label="Space verification"], section[aria-label="空间核验"]');
  if (!section) return null;
  const result = section.querySelector('[role="region"][aria-label="Space verification results"], [role="region"][aria-label="空间核验结果"]');
  const fields = element => Object.fromEntries([...element.querySelectorAll('dt')].map(term => [term.textContent.trim(), term.nextElementSibling?.textContent.trim()]));
  return {
    name: section.getAttribute('aria-label'), text: section.textContent,
    result: result ? {
      text: result.textContent,
      fields: fields(result),
      articles: [...result.querySelectorAll('article')].map(article => ({ name: article.getAttribute('aria-label'), fields: fields(article), dateTime: article.querySelector('time')?.dateTime })),
    } : null,
    alerts: [...section.querySelectorAll('[role="alert"]')].map(node => node.textContent.trim()),
    statuses: [...section.querySelectorAll('[role="status"]')].map(node => node.textContent.trim()),
    buttons: [...section.querySelectorAll('button')].map(button => ({ text: button.textContent.trim(), disabled: button.disabled })),
  };
}
function expectedBytes(value, locale) {
  if (value === undefined || value === null) return locale === 'zh-CN' ? '未知' : 'Unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const exponent = value > 0 ? Math.min(5, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: exponent ? 1 : 0 }).format(value / 1024 ** exponent)} ${units[exponent]}`;
}
function assertResult(result, summary) {
  assert.equal(result.scanId, summary.scanId);
  assert.equal(result.rootPath, summary.rootPath);
  assert.ok(Number.isFinite(result.current.measuredAt) && result.current.measuredAt > 0);
  assert.ok(Number.isFinite(result.current.total) && result.current.total >= 0);
  assert.ok(Number.isFinite(result.current.free) && result.current.free >= 0);
  assert.ok(result.current.free <= result.current.total);
  if (result.baseline) {
    assert.ok(result.baseline.measuredAt <= result.current.measuredAt);
    assert.equal(result.baseline.total, summary.volume.total);
    assert.equal(result.baseline.free, summary.volume.free);
  }
  if (result.comparison === 'comparable') assert.equal(result.delta, result.current.free - result.baseline.free);
  else assert.equal(result.delta, null);
}
function assertResultUI(ui, result, locale) {
  const label = (zh, en) => locale === 'zh-CN' ? zh : en;
  assert.ok(ui.result, 'The completed measurement should expose an accessible result region.');
  const current = ui.result.articles.find(article => article.name === label('本次核验', 'This check'));
  const baseline = ui.result.articles.find(article => article.name === label('扫描开始时', 'At scan start'));
  assert.ok(current && baseline);
  for (const [article, snapshot] of [[current, result.current], [baseline, result.baseline]]) {
    assert.equal(article.fields[label('可用空间', 'Available space')], expectedBytes(snapshot?.free, locale));
    assert.equal(article.fields[label('卷总容量', 'Volume capacity')], expectedBytes(snapshot?.total, locale));
    if (snapshot) assert.equal(Date.parse(article.dateTime), snapshot.measuredAt);
    else assert.equal(article.fields[label('测量时间（本地）', 'Measured (local time)')], label('未知', 'Unknown'));
  }
  const change = result.delta === null ? label('未知', 'Unknown')
    : `${result.delta > 0 ? '+' : result.delta < 0 ? '−' : ''}${expectedBytes(Math.abs(result.delta), locale)}`;
  assert.equal(ui.result.fields[label('卷可用空间变化', 'Change in volume available space')], change);
  if (result.comparison === 'baseline-unavailable') assert.ok(ui.result.text.includes(label('扫描开始时没有可用的容量记录', 'No capacity record was available at scan start')));
  if (result.comparison === 'volume-changed') assert.ok(ui.result.text.includes(label('卷容量或文件系统信息发生变化', 'Volume capacity or filesystem information changed')));
  if (result.comparison === 'comparable') assert.ok(ui.result.text.includes(label('这不是盘清保证释放的空间', 'this is not space DiskHarbor guarantees it freed')));
  assert.ok(ui.text.includes(label('变化不能直接归因于本次清理', 'the difference cannot be attributed directly to this cleanup')));
  assert.ok(ui.text.includes(label('盘清不观察或确认浏览器原生清理结果', 'DiskHarbor does not observe or confirm the browser’s native cleanup result')));
}
async function measureThroughUI() {
  const before = measurementCalls.length;
  await clickButton(['核验可用空间', 'Check available space'], 'section[aria-label="Space verification"] button, section[aria-label="空间核验"] button');
  await waitFor('exactly one explicit measurement returns', () => measurementCalls.length === before + 1 && measurementCalls[before].result);
  const result = measurementCalls[before].result;
  await waitFor('measurement result reaches the renderer', async () => {
    const ui = await render(spaceUI);
    return ui?.result && ui.result.articles.some(article => Date.parse(article.dateTime) === result.current.measuredAt);
  });
  assert.deepEqual(measurementCalls[before].args, [result.scanId]);
  return result;
}

async function timeoutChecks() {
  const summary = await startThroughUI(blockedScenario.rootPath);
  const entries = (await call('query', { kind: 'file', limit: 10 })).entries;
  assert.equal(entries.length, 1);
  const requestIndex = measurementCalls.length;
  const startedAt = Date.now();
  await clickButton(['Check available space'], 'section[aria-label="Space verification"] button');
  const worker = await waitFor('manual statfs is held in the synthetic worker', () => heldMeasurements.get(2));
  await waitFor('held measurement shows loading without the old result', async () => {
    const ui = await render(spaceUI);
    return ui && !ui.result && ui.statuses.some(text => text.includes('Reading available space on this volume'));
  });
  // Exercise the actual production 30-second timeout. No clock, timer or IPC
  // response is accelerated, and the underlying test read remains unresolved.
  await waitFor('real request timeout reaches the UI', async () => {
    const ui = await render(spaceUI);
    return ui && !ui.result && ui.alerts.some(text => text.includes('The space check timed out') && text.includes('underlying read may still be running'));
  }, 38000);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 29000, 'The timeout regression must wait for the real production timeout.');
  assert.equal(measurementCalls[requestIndex].error, 'SPACE_CHECK_TIMEOUT');
  assert.equal(heldMeasurements.get(2), worker);
  assert.equal(measurementResponses.filter(value => value.name === blockedScenario.name).length, 0);
  await assert.rejects(call('measureSpace', summary.scanId), /SPACE_CHECK_IN_PROGRESS/);
  await assert.rejects(call('planCleanup', [entries[0].id]), /SPACE_CHECK_IN_PROGRESS/);
  await assert.rejects(call('executeCleanup', 'fake'), /SPACE_CHECK_IN_PROGRESS/);
  assert.equal(trashCalls, 0);
  assert.equal((await render(spaceUI)).result, null);

  worker.postMessage({ type: 'space-harness-release', callNumber: 2 });
  heldMeasurements.delete(2);
  await waitFor('the real worker sends its late measurement response', () => measurementResponses.find(value => value.name === blockedScenario.name));
  await settleUI();
  const lateUI = await render(spaceUI);
  assert.equal(lateUI.result, null);
  assert.ok(lateUI.alerts.some(text => text.includes('The space check timed out')));
  const recovered = await measureThroughUI();
  assertResult(recovered, summary);
  assertResultUI(await render(spaceUI), recovered, 'en');
  report.timeout = { elapsedMs, error: measurementCalls[requestIndex].error, lateResultHidden: true, explicitlyRetried: true };
  report.checks.push('After the real 30-second timeout, unresolved statfs keeps measurement and cleanup locked; its late response stays hidden until an explicit successful retry.');

  const replacedRequest = measurementCalls.length;
  await clickButton(['Check available space'], 'section[aria-label="Space verification"] button');
  const replacedWorker = await waitFor('another manual read is held before replacement', () => heldMeasurements.get(4));
  assert.equal(replacedWorker, worker);
  await call('startScan', secondRoot);
  const replacement = await waitFor('replacement scan completes', async () => {
    let value;
    try { value = await call('summary'); }
    catch (error) {
      if (/(?:^|:\s*)(?:SCAN_REPLACED|NO_SCAN)$/.test(String(error?.message || error))) return false;
      throw error;
    }
    return value?.state === 'completed' && value.scanId !== summary.scanId ? value : false;
  });
  heldMeasurements.delete(4);
  await waitFor('the old held request is rejected on worker replacement', () => measurementCalls[replacedRequest].error === 'SCAN_REPLACED');
  await waitFor('replacement scan clears the old result, loading and errors', async () => {
    const ui = await render(spaceUI);
    return ui && ui.text.includes(secondRoot) && !ui.text.includes(blockedScenario.rootPath)
      && !ui.result && ui.alerts.length === 0 && ui.statuses.length === 0;
  });
  await settleUI();
  assert.equal((await render(spaceUI)).result, null);
  const replacementResult = await measureThroughUI();
  assertResult(replacementResult, replacement);
  assertResultUI(await render(spaceUI), replacementResult, 'en');
  report.timeout.replacementError = measurementCalls[replacedRequest].error;
  report.checks.push('Replacing a scan during another held read rejects its old request, removes stale UI and allows an explicit measurement for the new scan.');
}

async function execute() {
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(app.commandLine.hasSwitch('no-sandbox'), false);
  assert.match(window.webContents.getURL(), /^diskharbor:\/\/app\//);
  assert.equal(await call('summary'), null);
  assert.deepEqual(await call('history'), []);
  await clickButton(['Make room', '整理空间'], 'nav button');
  await waitFor('space verification panel is available', async () => !!(await render(spaceUI)));
  await settleUI();
  assert.equal(measurementCalls.length, 0);
  const initialUI = await render(spaceUI);
  assert.equal(initialUI.result, null);
  assert.ok(initialUI.buttons.some(button => button.text === '核验可用空间' && button.disabled));
  report.checks.push('The isolated production renderer keeps its sandbox and does not measure available space on startup or navigation.');

  await assert.rejects(call('measureSpace', 'no-current-scan'), /NO_SCAN/);
  const callsBeforeScan = measurementCalls.length;
  const first = await startThroughUI(firstRoot);
  await settleUI();
  assert.equal(measurementCalls.length, callsBeforeScan);
  assert.equal((await render(spaceUI)).result, null);
  const real = await measureThroughUI();
  assertResult(real, first);
  assertResultUI(await render(spaceUI), real, 'zh-CN');
  assert.equal(workerMeasurements.length, 0, 'The initial measurement must use the unmodified filesystem statfs call.');
  report.realMeasurement = real;
  report.checks.push('Only an explicit UI click measures the real containing volume through the production worker, and displayed values match the returned baseline and current snapshot.');

  const previousCalls = measurementCalls.length;
  await clickButton(['File tree', '文件树'], 'nav button');
  await clickButton(['Make room', '整理空间'], 'nav button');
  await settleUI();
  assertResultUI(await render(spaceUI), real, 'zh-CN');
  await clickButton(['切换为英文']);
  await waitFor('space result changes language', async () => (await render(spaceUI))?.name === 'Space verification');
  assertResultUI(await render(spaceUI), real, 'en');
  assert.equal(measurementCalls.length, previousCalls);
  report.checks.push('Page navigation and switching to English preserve the same measured result without triggering another measurement.');

  for (const invalid of [null, 1, firstRoot, { scanId: first.scanId, rootPath: secondRoot, baseline: { measuredAt: 1, total: 1, free: 999999999 } }]) {
    await assert.rejects(call('measureSpace', invalid), /SCAN_CHANGED/);
  }
  assertResultUI(await render(spaceUI), real, 'en');
  report.checks.push('Invalid tokens, arbitrary paths and renderer-supplied baseline objects are refused instead of being used as measurement inputs.');

  const beforeSecond = measurementCalls.length;
  const second = await startThroughUI(secondRoot);
  await settleUI();
  const cleared = await render(spaceUI);
  assert.equal(cleared.result, null);
  assert.equal(cleared.text.includes(firstRoot), false);
  assert.equal(measurementCalls.length, beforeSecond);
  await assert.rejects(call('measureSpace', first.scanId), /SCAN_CHANGED/);
  assert.notEqual(second.scanId, first.scanId);
  report.checks.push('Changing scan scope clears the previous result without measuring automatically and rejects the old scan token.');

  report.syntheticMeasurements = [];
  for (const scenario of scenarios) {
    const summary = await startThroughUI(scenario.rootPath);
    const result = await measureThroughUI();
    assertResult(result, summary);
    assert.equal(result.comparison, scenario.comparison);
    assert.equal(result.delta, scenario.delta);
    assert.equal(result.current.free, scenario.currentFree * 4096);
    assert.equal(result.current.total, (scenario.currentTotal || scenario.total) * 4096);
    if (scenario.baselineFree === null) assert.equal(result.baseline, null);
    else assert.equal(result.baseline.free, scenario.baselineFree * 4096);
    assertResultUI(await render(spaceUI), result, 'en');
    assert.ok(workerMeasurements.filter(value => value.name === scenario.name).length >= 2);
    report.syntheticMeasurements.push({ scenario: scenario.name, comparison: result.comparison, delta: result.delta });
  }
  report.checks.push('Explicit test-worker statfs fixtures cover positive, negative and zero changes, an unavailable baseline, and changed capacity without claiming reclaimed bytes.');

  const identityScan = await startThroughUI(identityRoot);
  const originalIdentity = await fs.lstat(identityRoot, { bigint: true });
  await fs.rename(identityRoot, identityOriginal);
  await fs.mkdir(identityRoot);
  await fs.writeFile(path.join(identityRoot, 'replacement.txt'), 'A different directory at the same synthetic pathname.\n');
  const replacementIdentity = await fs.lstat(identityRoot, { bigint: true });
  assert.notEqual(`${originalIdentity.dev}:${originalIdentity.ino}`, `${replacementIdentity.dev}:${replacementIdentity.ino}`);
  await assert.rejects(call('measureSpace', identityScan.scanId), /SPACE_ROOT_CHANGED/);
  await clickButton(['Check available space'], 'section[aria-label="Space verification"] button');
  await waitFor('root identity rejection is explained without retaining an old result', async () => {
    const ui = await render(spaceUI);
    return ui && !ui.result && ui.alerts.some(text => text.includes('The scan root changed or could not be verified'));
  });
  // Restore both fixture directories without deleting either one's files.
  await fs.rename(identityRoot, identityReplacement);
  await fs.rename(identityOriginal, identityRoot);
  assert.equal(await fs.readFile(path.join(identityRoot, 'original.txt'), 'utf8'), 'The original synthetic directory.\n');
  assert.equal(await fs.readFile(path.join(identityReplacement, 'replacement.txt'), 'utf8'), 'A different directory at the same synthetic pathname.\n');
  report.checks.push('Replacing the real temporary scan root at the same pathname is rejected by identity, and both original and replacement fixtures are preserved.');

  await timeoutChecks();

  assert.equal(trashCalls, 0);
  assert.deepEqual(await call('history'), []);
  assert.equal(await fs.readFile(path.join(firstRoot, 'retained.txt'), 'utf8'), 'Space checks read metadata without deleting this file.\n');
  assert.deepEqual(report.errors, []);
  report.checks.push('Space checks leave fixture files and cleanup history unchanged and never call the system Trash API.');
}

try {
  for (const directory of [firstRoot, secondRoot, identityRoot, userData, process.env.XDG_DATA_HOME, ...workerScenarios.map(value => value.rootPath)]) fsSync.mkdirSync(directory, { recursive: true });
  fsSync.writeFileSync(path.join(firstRoot, 'retained.txt'), 'Space checks read metadata without deleting this file.\n');
  fsSync.writeFileSync(path.join(secondRoot, 'second.txt'), 'A separate synthetic scan scope.\n');
  fsSync.writeFileSync(path.join(identityRoot, 'original.txt'), 'The original synthetic directory.\n');
  for (const scenario of workerScenarios) fsSync.writeFileSync(path.join(scenario.rootPath, 'retained.txt'), `Explicit statfs fixture: ${scenario.name}.\n`);
  fsSync.writeFileSync(bootstrap, `
'use strict';
const fs = require('node:fs/promises');
const { parentPort, workerData } = require('node:worker_threads');
const control = workerData.spaceHarness;
const scenario = control.scenario;
const original = fs.statfs;
let calls = 0;
const releases = new Map();
parentPort.on('message', message => {
  if (message?.type !== 'space-harness-release') return;
  const release = releases.get(message.callNumber);
  if (release) { releases.delete(message.callNumber); release(); }
});
fs.statfs = async function (target, ...args) {
  const value = Buffer.isBuffer(target) ? target.toString('utf8') : String(target);
  if (value !== scenario.rootPath) return original.call(this, target, ...args);
  const callNumber = ++calls;
  parentPort.postMessage({ type: 'space-harness-statfs', name: scenario.name, callNumber });
  if (scenario.gateCalls?.includes(callNumber)) {
    const released = new Promise(resolve => { releases.set(callNumber, resolve); });
    parentPort.postMessage({ type: 'space-harness-gated', name: scenario.name, callNumber });
    await released;
  }
  if (callNumber === 1 && scenario.baselineFree === null) throw Object.assign(new Error('Synthetic unavailable baseline.'), { code: 'EIO' });
  const actual = await original.call(this, target, ...args);
  const bigint = typeof actual.bsize === 'bigint';
  const number = input => bigint ? BigInt(input) : input;
  const total = callNumber === 1 ? scenario.total : scenario.currentTotal || scenario.total;
  const free = callNumber === 1 ? scenario.baselineFree : scenario.currentFree;
  return { ...actual, bsize: number(4096), blocks: number(total), bavail: number(free), bfree: number(free) };
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
