'use strict';

// Exercise the production renderer, preload, IPC and scanner using only
// disposable directories. Only the explicit device-error scenario injects an
// opendir rejection for its own fixture; renderer timings remain unmodified.
const { app, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const workerThreads = require('node:worker_threads');

const base = process.env.DISKHARBOR_SCOPE_SMOKE_DIR;
assert.ok(base && path.isAbsolute(base) && path.basename(base).startsWith('scope-smoke-'));
const firstRoot = path.join(base, 'first-scope');
const secondRoot = path.join(base, 'second-scope');
const outside = path.join(base, 'outside-scope');
const faultRoot = path.join(base, 'synthetic-unavailable-device');
const bootstrap = path.join(base, 'worker-bootstrap.cjs');
const userData = path.join(base, 'user-data');
const ordinaryPath = path.join(firstRoot, 'ordinary.txt');
const hiddenPath = path.join(firstRoot, '.hidden-note.txt');
const outsidePath = path.join(outside, 'outside-only.txt');
const linkPath = path.join(firstRoot, 'external-link');
const report = { platform: process.platform, checks: [], errors: [] };
const originalTrash = shell.trashItem;
const NativeWorker = workerThreads.Worker;
const createdWorkers = [];
let faultPending = false;
let window;
let finishing = false;
let trashCalls = 0;

shell.trashItem = async function () {
  trashCalls += 1;
  throw new Error('Scan scope inspection must never call the system Trash API.');
};
// Only the first requested worker for this synthetic root rejects opendir.
// The main-process preflight and every subsequent retry remain real.
workerThreads.Worker = class ScopeWorker extends NativeWorker {
  constructor(filename, options) {
    const scanWorker = path.basename(String(filename)) === 'scan-worker.cjs';
    const inject = scanWorker && faultPending && options?.workerData?.rootPath === faultRoot;
    if (inject) faultPending = false;
    super(inject ? bootstrap : filename, inject ? {
      ...options,
      workerData: { ...options.workerData, scopeHarness: { entry: String(filename), faultPath: faultRoot } },
    } : options);
    if (scanWorker) createdWorkers.push({ rootPath: options.workerData.rootPath, scanId: options.workerData.scanId, syntheticFault: inject });
  }
};
app.setPath('userData', userData);
app.setPath('sessionData', path.join(userData, 'session'));
app.commandLine.appendSwitch('disable-gpu');
const watchdog = setTimeout(() => finish(new Error('Scan scope desktop smoke timed out.')), 90000);

async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  shell.trashItem = originalTrash;
  workerThreads.Worker = NativeWorker;
  report.result = error ? 'failed' : 'passed';
  if (error) {
    report.error = String(error.stack || error);
    if (window && !window.isDestroyed()) {
      report.ui = await render(scopeUI).catch(() => null);
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
  throw new Error(`Scan scope smoke wait failed: ${description}`);
}
function waitForUI(description, read, ...args) {
  return waitFor(description, () => render(read, ...args));
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
async function startThroughUI(target, expectedState = 'completed') {
  const previous = await call('summary');
  await waitForUI('editable scan location', value => {
    const input = document.querySelector('input[aria-label="Scan path"], input[aria-label="扫描路径"]');
    if (!input || input.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, target);
  await clickButton(['Start scan', '开始扫描', 'Scan again', '重新扫描'], 'section[aria-label="Scan location"] button, section[aria-label="扫描位置"] button');
  return waitFor(`new ${expectedState} scan`, async () => {
    let value;
    try { value = await call('summary'); }
    catch (error) {
      if (/(?:^|:\s*)(?:SCAN_REPLACED|NO_SCAN)$/.test(String(error?.message || error))) return false;
      throw error;
    }
    if (value?.state === 'error' && expectedState !== 'error') throw new Error(value.message || 'Scan failed.');
    return value?.state === expectedState && value.scanId !== previous?.scanId ? value : false;
  });
}

function scopeUI() {
  const section = document.querySelector('section[aria-label="Scan scope"], section[aria-label="扫描范围"]');
  if (!section) return null;
  const button = section.querySelector('button[aria-controls]');
  const region = section.querySelector('[role="region"]');
  return {
    name: section.getAttribute('aria-label'),
    text: section.textContent,
    expanded: button?.getAttribute('aria-expanded'),
    controls: button?.getAttribute('aria-controls'),
    buttonText: button?.textContent,
    region: region ? { id: region.id, name: region.getAttribute('aria-label'), visible: !!region.getClientRects().length, tabIndex: region.tabIndex } : null,
    fields: Object.fromEntries([...section.querySelectorAll('dt')].map(term => [term.textContent.trim(), term.nextElementSibling?.textContent.trim()])),
    dateTime: region?.querySelector('time')?.dateTime,
  };
}
async function openScope() {
  const before = await call('summary');
  const click = await render(() => {
    const buttons = [...document.querySelectorAll('section[aria-label="扫描范围"] button, section[aria-label="Scan scope"] button')];
    if (buttons.length !== 1) throw new Error(`Expected one scope disclosure; found ${buttons.length}.`);
    const button = buttons[0];
    const outerHTML = button.outerHTML;
    const beforeExpanded = button.getAttribute('aria-expanded');
    button.focus({ preventScroll: true });
    button.click();
    return { outerHTML, beforeExpanded, afterExpanded: button.getAttribute('aria-expanded'), connected: button.isConnected };
  });
  await render(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await call('summary');
  (report.scopeClicks ||= []).push({ beforeScanId: before.scanId, afterScanId: after.scanId, click, afterUI: await render(scopeUI) });
  return waitFor('expanded scope region', async () => {
    const ui = await render(scopeUI);
    return ui?.expanded === 'true' && ui.region?.visible ? ui : false;
  });
}
function expectedBytes(value, locale) {
  if (value === undefined || value === null) return locale === 'zh-CN' ? '未知' : 'Unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const exponent = value > 0 ? Math.min(5, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: exponent ? 1 : 0 }).format(value / 1024 ** exponent)} ${units[exponent]}`;
}
function assertScopeValues(ui, summary, locale) {
  const zh = locale === 'zh-CN';
  const label = (chinese, english) => zh ? chinese : english;
  const number = value => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
  assert.equal(ui.region.name, label('扫描范围详情', 'Scan scope details'));
  assert.equal(ui.controls, ui.region.id);
  assert.equal(ui.region.tabIndex, 0);
  assert.equal(ui.fields[label('所选根路径', 'Selected root path')], summary.rootPath);
  assert.equal(Date.parse(ui.dateTime), summary.startedAt);
  assert.ok(ui.fields[label('开始时间（本地）', 'Started (local time)')].length > 10);
  assert.ok(summary.elapsedMs < 60000, 'Small synthetic scans should complete in less than one minute.');
  assert.equal(ui.fields[label('已用时间', 'Elapsed time')], `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(summary.elapsedMs / 1000)} ${zh ? '秒' : 's'}`);
  assert.equal(ui.fields[label('所在卷总容量', 'Volume capacity')], expectedBytes(summary.volume?.total, locale));
  assert.equal(ui.fields[label('所在卷可用空间', 'Volume available space')], expectedBytes(summary.volume?.free, locale));
  for (const [key, chinese, english] of [
    ['deviceId', '本次扫描设备编号', 'Device ID for this scan'],
    ['filesystem', '文件系统', 'Filesystem'],
    ['mountPath', '挂载位置', 'Mount location'],
  ]) assert.equal(ui.fields[label(chinese, english)], summary.coverage[key] || label('未知', 'Unknown'));
  for (const [value, chinese, english] of [
    [summary.errors, '读取错误', 'Read errors'],
    [summary.skipped, '跳过项目合计', 'Total skipped items'],
    [summary.coverage.skipped.mounts, '卷或挂载边界', 'Volume or mount boundaries'],
    [summary.coverage.skipped.symbolicLinks, '符号链接', 'Symbolic links'],
    [summary.coverage.skipped.virtualFilesystems, '虚拟文件系统', 'Virtual filesystems'],
    [summary.coverage.skipped.specialFiles, '特殊文件', 'Special files'],
    [summary.coverage.unknownAllocatedEntries, '实际占用未知的项目', 'Items with unknown space on disk'],
    [summary.coverage.unsupportedNames, '路径编码不支持的项目', 'Items with unsupported path encoding'],
  ]) assert.equal(ui.fields[label(chinese, english)], number(value));
  assert.ok(ui.text.includes(label('扫描开始时所在卷的快照', 'snapshot of the containing volume at scan start')));
  assert.ok(ui.text.includes(label('不是所选文件夹的容量，也不是当前实时可用空间', 'not the selected folder’s capacity or live available space')));
  assert.ok(ui.text.includes(label('不是永久磁盘序列号', 'not a permanent disk serial number')));
  assert.ok(ui.text.includes(label('普通隐藏文件仍在扫描范围内', 'Regular hidden files remain in scope')));
  assert.ok(ui.text.includes(label('实际占用未知不按 0 计算', 'Unknown space on disk is not treated as zero')));
  assert.ok(ui.text.includes(label('跳过计数表示已发现的入口数量', 'Skipped counts refer to discovered entries')));
  const boundaryText = summary.coverage.boundaryDetection === 'mount-table'
    ? label('使用扫描开始时的 Linux 挂载信息识别边界', 'Linux mount information recorded at scan start is used to detect boundaries')
    : !summary.coverage.deviceId
      ? label('设备编号暂不可用，无法确认扫描边界', 'The device ID is unavailable, so scan boundaries cannot be confirmed')
      : label('目前只能根据设备编号识别部分边界', 'Only device IDs are available to detect some boundaries');
  assert.ok(ui.text.includes(boundaryText));
}
async function syntheticFailureChecks() {
  faultPending = true;
  const failed = await startThroughUI(faultRoot, 'error');
  assert.equal(failed.errors, 1);
  const issue = failed.errorDetails.find(item => item.id === failed.rootId && item.code === 'ENODEV');
  assert.ok(issue, 'The test-only opendir fault must produce a real root read issue.');
  assert.equal((await call('entry', issue.id)).path, faultRoot);
  assert.equal(createdWorkers.at(-1).syntheticFault, true);
  await waitFor('failed scan resets scope disclosure', async () => {
    const ui = await render(scopeUI);
    return ui?.expanded === 'false' && !ui.region && ui.buttonText.includes('Scan incomplete');
  });
  const english = await openScope();
  assertScopeValues(english, failed, 'en');
  assert.ok(english.text.includes('The scan did not finish.'));
  assert.equal(english.text.includes('This scan has finished;'), false);
  await clickButton(['Review read errors', '查看读取问题']);
  await waitForUI('English unavailable-device explanation', target => {
    const section = document.querySelector('section[aria-label="Read errors"]');
    return section?.textContent.includes(target) && section.textContent.includes('The device is unavailable. Reconnect it and check the location before scanning again.');
  }, faultRoot);
  await clickButton(['Switch to Chinese']);
  await waitForUI('Chinese unavailable-device explanation', target => {
    const section = document.querySelector('section[aria-label="读取问题"]');
    return section?.textContent.includes(target) && section.textContent.includes('设备已不可用，请重新连接并确认位置后再扫描。');
  }, faultRoot);
  const chinese = await render(scopeUI);
  assert.ok(chinese.text.includes('扫描未完整结束'));
  report.checks.push('A test-only ENODEV fault on the synthetic root is shown as an incomplete scan with bilingual read-error guidance.');

  await clickButton(['重新扫描此范围', 'Scan this scope again'], 'section[aria-label="读取问题"] button, section[aria-label="Read errors"] button');
  const recovered = await waitFor('fresh retry completes without the injected fault', async () => {
    let value;
    try { value = await call('summary'); }
    catch (error) {
      if (/(?:^|:\s*)(?:SCAN_REPLACED|NO_SCAN)$/.test(String(error?.message || error))) return false;
      throw error;
    }
    if (value?.scanId === failed.scanId) return false;
    if (value?.state === 'error') throw new Error(value.message || 'Scope retry failed.');
    return value?.state === 'completed' ? value : false;
  });
  assert.equal(recovered.rootPath, faultRoot);
  assert.equal(recovered.files, 1);
  assert.equal(recovered.errors, 0);
  assert.equal(createdWorkers.at(-1).syntheticFault, false);
  await waitFor('retry clears disclosure and stale read issues', async () => {
    const ui = await render(scopeUI);
    const oldIssue = await render(() => !!document.querySelector('section[aria-label="Read errors"], section[aria-label="读取问题"]'));
    return ui?.expanded === 'false' && !ui.region && !ui.text.includes('扫描未完成') && !oldIssue;
  });
  const files = (await call('query', { kind: 'file', limit: 100 })).entries;
  assert.deepEqual(files.map(entry => entry.path), [path.join(faultRoot, 'recoverable.txt')]);
  assertScopeValues(await openScope(), recovered, 'zh-CN');
  report.syntheticFault = { code: 'ENODEV', rootPath: faultRoot, failedScanId: failed.scanId, recoveredScanId: recovered.scanId };
  report.checks.push('Retrying the explained synthetic failure creates an unmodified worker, completes the same scope, and clears stale scope/error UI.');
}

async function execute() {
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(app.commandLine.hasSwitch('no-sandbox'), false);
  assert.match(window.webContents.getURL(), /^diskharbor:\/\/app\//);
  assert.equal(await call('summary'), null);
  assert.equal(await render(scopeUI), null);
  assert.deepEqual(await call('history'), []);
  report.checks.push('Production sandbox starts without an automatic scan or a cleanup operation.');

  const first = await startThroughUI(firstRoot);
  assert.equal(first.rootPath, firstRoot);
  assert.equal(first.files, 2);
  assert.equal(first.errors, 0);
  assert.ok(first.startedAt > 0 && first.startedAt <= Date.now());
  assert.ok(Number.isFinite(first.elapsedMs) && first.elapsedMs >= 0);
  const entries = (await call('query', { kind: 'file', limit: 100 })).entries;
  assert.deepEqual(entries.map(entry => entry.path).sort(), [ordinaryPath, hiddenPath].sort());
  const coverage = first.coverage;
  assert.ok(coverage && typeof coverage === 'object');
  for (const key of ['deviceId', 'mountPath', 'filesystem']) assert.ok(coverage[key] === null || typeof coverage[key] === 'string');
  assert.ok(['mount-table', 'device-only'].includes(coverage.boundaryDetection));
  for (const key of ['mounts', 'symbolicLinks', 'virtualFilesystems', 'specialFiles']) assert.ok(Number.isInteger(coverage.skipped[key]) && coverage.skipped[key] >= 0);
  assert.equal(coverage.skipped.symbolicLinks, process.platform === 'linux' ? 1 : 0);
  assert.ok(Number.isInteger(coverage.unknownAllocatedEntries) && coverage.unknownAllocatedEntries >= 0);
  assert.equal(coverage.unsupportedNames, 0);
  const children = (await call('query', { parentId: first.rootId, limit: 100 })).entries;
  assert.equal(coverage.unknownAllocatedEntries, children.filter(entry => ['file', 'symlink'].includes(entry.kind) && entry.allocatedSize === null).length);
  if (process.platform === 'linux') {
    const links = children.filter(entry => entry.kind === 'symlink');
    assert.equal(links.length, 1);
    assert.equal(links[0].path, linkPath);
    assert.equal(links[0].state, 'skipped');
    assert.deepEqual((await call('query', { search: 'outside-only', limit: 100 })).entries, []);
  }
  report.scan = { scanId: first.scanId, rootPath: first.rootPath, startedAt: first.startedAt, elapsedMs: first.elapsedMs, coverage };
  report.checks.push('Coverage describes the actual ordinary and hidden files; Linux counts the skipped symlink without indexing its outside target.');

  await waitFor('scope is collapsed by default', async () => {
    const ui = await render(scopeUI);
    return ui?.expanded === 'false' && !ui.region && ui.buttonText.includes('扫描已结束');
  });
  const chinese = await openScope();
  assertScopeValues(chinese, first, 'zh-CN');
  assert.ok(chinese.text.includes('不表示已覆盖整块磁盘或没有遗漏'));
  report.checks.push('The scope disclosure starts collapsed and exposes exact path, start time, duration, volume snapshot, identity and coverage in Chinese.');
  await clickButton(['切换为英文']);
  const english = await waitFor('scope translates without losing the current scan', async () => {
    const ui = await render(scopeUI);
    return ui?.name === 'Scan scope' && ui.expanded === 'true' ? ui : false;
  });
  assertScopeValues(english, first, 'en');
  assert.ok(english.text.includes('does not mean the whole disk was covered or nothing was missed'));
  assert.equal((await call('summary')).scanId, first.scanId);
  report.identityUnknownFields = ['deviceId', 'filesystem', 'mountPath'].filter(key => first.coverage[key] === null);
  report.checks.push('English scope text preserves the same scan and shows Unknown for unavailable identity fields without guessing.');

  const second = await startThroughUI(secondRoot);
  await waitFor('new scope automatically collapses and removes the old root', async () => {
    const ui = await render(scopeUI);
    return ui?.expanded === 'false' && !ui.region && !ui.text.includes(firstRoot) && ui.buttonText.includes('Scan finished');
  });
  const secondUI = await openScope();
  assertScopeValues(secondUI, second, 'en');
  assert.equal(secondUI.text.includes(firstRoot), false);
  assert.equal(second.files, 1);
  assert.equal(second.coverage.skipped.symbolicLinks, 0);
  report.checks.push('A new scan collapses the disclosure and replaces root, timing and coverage instead of retaining the previous scope.');

  await syntheticFailureChecks();
  assert.equal(trashCalls, 0);
  assert.deepEqual(await call('history'), []);
  assert.equal(await fs.readFile(ordinaryPath, 'utf8'), 'An ordinary synthetic file.\n');
  assert.equal(await fs.readFile(hiddenPath, 'utf8'), 'Hidden names are included in the scan.\n');
  assert.equal(await fs.readFile(outsidePath, 'utf8'), 'This file must never enter the first scan.\n');
  assert.deepEqual(report.errors, []);
  report.checks.push('Scope inspection and retry leave every fixture intact, create no cleanup records and make no Trash calls.');
}

try {
  for (const directory of [firstRoot, secondRoot, outside, faultRoot, userData, process.env.XDG_DATA_HOME]) fsSync.mkdirSync(directory, { recursive: true });
  fsSync.writeFileSync(ordinaryPath, 'An ordinary synthetic file.\n');
  fsSync.writeFileSync(hiddenPath, 'Hidden names are included in the scan.\n');
  fsSync.writeFileSync(path.join(secondRoot, 'second-only.txt'), 'A separate scan scope.\n');
  fsSync.writeFileSync(outsidePath, 'This file must never enter the first scan.\n');
  fsSync.writeFileSync(path.join(faultRoot, 'recoverable.txt'), 'Synthetic device-read failure fixture.\n');
  if (process.platform === 'linux') fsSync.symlinkSync(outside, linkPath, 'dir');
  else report.symlinkFixture = 'Not created: this native scenario only sets up symbolic links on Linux.';
  fsSync.writeFileSync(bootstrap, `
'use strict';
const fs = require('node:fs/promises');
const { workerData } = require('node:worker_threads');
const control = workerData.scopeHarness;
const original = fs.opendir;
fs.opendir = async function (target, ...args) {
  const value = Buffer.isBuffer(target) ? target.toString('utf8') : String(target);
  if (value === control.faultPath) throw Object.assign(new Error('Synthetic fixture device unavailable.'), { code: 'ENODEV' });
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
    window.webContents.once('did-finish-load', () => execute().then(() => finish(), finish));
  });
  require('../electron/main.cjs');
} catch (error) { void finish(error); }
