'use strict';

// Run through `npm run test:desktop`, after building the renderer. Only this
// disposable harness controls confirmation. Production has no bypass switch.
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const base = process.env.DISKHARBOR_SMOKE_DIR;
assert.ok(base && path.isAbsolute(base) && path.basename(base).startsWith('native-smoke-'));
const root = path.join(base, 'files');
const userData = path.join(base, 'user-data');
const historyPath = path.join(userData, 'operation-history.json');
const coldStart = process.env.DISKHARBOR_SMOKE_PHASE === 'reload';
const report = coldStart ? JSON.parse(fsSync.readFileSync(path.join(base, 'report-primary.json'), 'utf8'))
  : { platform: process.platform, checks: [], errors: [] };
const originalStatfs = fs.statfs;
const operationStatfsReads = [];
let statfsScenario = null;
let coldTrashCalls = 0;
fs.statfs = async function (target, ...args) {
  const value = Buffer.isBuffer(target) ? target.toString('utf8') : String(target);
  if (!value.startsWith(`${base}${path.sep}`)) return originalStatfs.call(this, target, ...args);
  const scenario = statfsScenario?.rootPath === value ? statfsScenario : null;
  const read = { rootPath: value, scenario: scenario?.name || 'real' };
  operationStatfsReads.push(read);
  const callNumber = scenario ? ++scenario.calls : 0;
  if (scenario?.name === 'after-unavailable' && callNumber === 2) {
    read.error = 'EIO';
    throw Object.assign(new Error('Synthetic post-operation statfs failure.'), { code: 'EIO' });
  }
  const actual = await originalStatfs.call(this, target, ...args);
  if (!scenario) return actual;
  const number = input => typeof actual.bsize === 'bigint' ? BigInt(input) : input;
  const blocks = scenario.name === 'volume-changed' && callNumber === 2 ? 2000 : 1000;
  return { ...actual, bsize: number(4096), blocks: number(blocks), bavail: number(callNumber === 1 ? 400 : 500) };
};
let window;
let finishing = false;
let originalTrash;
let originalDialog;
const previewRequests = [];
const originalHandle = ipcMain.handle;
// Count real preview IPC calls without changing their arguments or behavior.
// Restore the public registration method after production handlers are installed.
ipcMain.handle = function (channel, listener) {
  return originalHandle.call(this, channel, channel === 'diskharbor:preview' ? (event, ...args) => {
    previewRequests.push(args);
    return listener(event, ...args);
  } : listener);
};
app.setPath('userData', userData);
app.setPath('sessionData', path.join(userData, 'session'));
app.commandLine.appendSwitch('disable-gpu');
const watchdog = setTimeout(() => finish(new Error('Desktop smoke test timed out.')), 60000);

async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  ipcMain.handle = originalHandle;
  fs.statfs = originalStatfs;
  if (originalTrash) shell.trashItem = originalTrash;
  if (originalDialog) dialog.showMessageBox = originalDialog;
  report.result = error ? 'failed' : 'passed';
  if (error) report.error = String(error.stack || error);
  await fs.writeFile(path.join(base, 'report.json'), JSON.stringify(report, null, 2));
  if (!coldStart) await fs.writeFile(path.join(base, 'report-primary.json'), JSON.stringify(report, null, 2));
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
async function scan(target = root) {
  await call('startScan', target);
  for (let i = 0; i < 200; i++) {
    const summary = await call('summary');
    if (summary?.state === 'completed') return summary;
    if (summary?.state === 'error') throw new Error(summary.message || 'Scan failed.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Scan did not complete.');
}
async function exists(file) { return fs.lstat(file).then(() => true, () => false); }

async function inspectPreviewFixture(filePath) {
  await waitForUI('preview fixture row', target => {
    const grid = document.querySelector('[role="treegrid"]');
    const label = [...(grid?.querySelectorAll('[role="row"] [title]') || [])].find(node => node.title === target && node.textContent.trim() === target.split(/[\\/]/).pop());
    if (!label) return false;
    label.closest('[role="row"]').click();
    return true;
  }, filePath);
  await waitForUI('explicit preview button', () => {
    const button = [...document.querySelectorAll('button')].find(node => ['Preview content', '预览内容'].includes(node.textContent.trim()));
    return button && !button.disabled && button.getClientRects().length;
  });
  // Let rendering and effects settle before checking that inspecting metadata
  // has not itself requested file contents.
  await render(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function openPreview() {
  await render(() => {
    const button = [...document.querySelectorAll('button')].find(node => ['Preview content', '预览内容'].includes(node.textContent.trim()));
    if (!button || button.disabled) throw new Error('Preview button is unavailable.');
    button.focus();
    button.click();
  });
  await waitForUI('content preview dialog', () => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog?.querySelector('#file-preview-heading') && dialog.getAttribute('aria-modal') === 'true';
  });
}

async function closePreview() {
  await clickButton(['Close preview', '关闭预览'], '[role="dialog"] button');
  await waitForUI('closed preview and restored focus', () => {
    const button = document.activeElement;
    return !document.querySelector('[role="dialog"]') && button?.tagName === 'BUTTON' && ['Preview content', '预览内容'].includes(button.textContent.trim());
  });
}

async function previewChecks() {
  assert.equal(previewRequests.length, 0, 'Scanning and cleanup must not automatically read preview contents.');
  const textPath = path.join(root, 'preview-sample.txt');
  const imagePath = path.join(root, 'preview-sample.png');
  const text = 'DiskHarbor preview — 盘清\n<div id="preview-unsafe-node">Literal HTML</div>\n<script>document.documentElement.setAttribute("data-preview-executed", "yes")</script>\n';
  await fs.writeFile(textPath, text);
  await fs.copyFile(path.join(__dirname, '..', 'assets', 'icon.png'), imagePath);
  const previousScan = await call('summary');
  await clickButton(['Update scan', '更新扫描']);
  await waitForUI('preview fixtures scanned through the UI', async oldId => {
    let current;
    try { current = await window.diskharbor.summary(); }
    catch (error) {
      if (/(?:^|:\s*)(?:SCAN_REPLACED|NO_SCAN)$/.test(String(error?.message || error))) return false;
      throw error;
    }
    return current?.state === 'completed' && current.scanId !== oldId;
  }, previousScan.scanId);
  const currentScan = await call('summary');
  const entries = (await call('query', { kind: 'file', limit: 100 })).entries;
  const textEntry = entries.find(item => item.path === textPath);
  const imageEntry = entries.find(item => item.path === imagePath);
  assert.ok(textEntry && imageEntry, 'Preview fixtures must be in the new scan.');
  assert.equal(previewRequests.length, 0);
  await assert.rejects(call('preview', textEntry.id, previousScan.scanId), /SCAN_CHANGED/);
  report.checks.push('Preview rejects a stale scan ID before reading a fixture.');

  if (process.platform === 'linux') {
    const textResult = await call('preview', textEntry.id, currentScan.scanId);
    assert.equal(textResult.kind, 'text');
    assert.equal(textResult.text, text);
    assert.equal(textResult.mime, 'text/plain');
    assert.equal(textResult.bytesRead, Buffer.byteLength(text));
    assert.equal(textResult.truncated, false);
    const imageResult = await call('preview', imageEntry.id, currentScan.scanId);
    assert.equal(imageResult.kind, 'image');
    assert.equal(imageResult.mime, 'image/png');
    assert.match(imageResult.dataUrl, /^data:image\/png;base64,/);
    assert.ok(imageResult.width > 0 && imageResult.height > 0);
    assert.equal(imageResult.bytesRead, (await fs.stat(imagePath)).size);
    report.checks.push('Linux preview reads real UTF-8 text and a bounded PNG through production IPC.');
  } else {
    await assert.rejects(call('preview', textEntry.id, currentScan.scanId), /PREVIEW_PLATFORM_UNVERIFIED/);
    await assert.rejects(call('preview', imageEntry.id, currentScan.scanId), /PREVIEW_PLATFORM_UNVERIFIED/);
    report.checks.push('Unverified preview platforms refuse both text and image reads explicitly.');
  }

  let requestsBefore = previewRequests.length;
  await inspectPreviewFixture(textPath);
  assert.equal(previewRequests.length, requestsBefore, 'Inspecting a file must leave preview reads opt-in.');
  assert.equal(await render(() => !!document.querySelector('[role="dialog"]')), false);
  await openPreview();
  if (process.platform === 'linux') {
    await waitForUI('literal UTF-8 text in preview', expected => {
      const region = document.querySelector('[role="dialog"] pre[role="region"]');
      return region?.textContent === expected;
    }, text);
    assert.deepEqual(await render(() => ({
      injectedNode: !!document.querySelector('#preview-unsafe-node'),
      executed: document.documentElement.getAttribute('data-preview-executed'),
      scripts: document.querySelectorAll('[role="dialog"] script').length,
    })), { injectedNode: false, executed: null, scripts: 0 });
    report.checks.push('Explicit text preview renders HTML as inert literal text.');
  } else {
    await waitForUI('visible unsupported preview outcome', () => {
      const alert = document.querySelector('[role="dialog"] [role="alert"]');
      return alert && /Windows|macOS|平台|platform/i.test(alert.textContent);
    });
    report.checks.push('The preview dialog explains the platform restriction without reading contents.');
  }
  assert.equal(previewRequests.length, requestsBefore + 1);
  await closePreview();

  if (process.platform === 'linux') {
    requestsBefore = previewRequests.length;
    await inspectPreviewFixture(imagePath);
    assert.equal(previewRequests.length, requestsBefore, 'Inspecting an image must not load its contents automatically.');
    await openPreview();
    await waitForUI('decoded fixture image in preview', () => {
      const image = document.querySelector('[role="dialog"] img');
      return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0 && image.src.startsWith('data:image/png;base64,');
    });
    assert.equal(previewRequests.length, requestsBefore + 1);
    await closePreview();
    report.checks.push('Explicit image preview loads its PNG and closing restores the triggering button focus.');
  }
  assert.equal(await fs.readFile(textPath, 'utf8'), text);
  assert.equal(await exists(imagePath), true);
  assert.equal((await call('history')).length, 4, 'Read-only previews must not create cleanup journal records.');
  report.checks.push('Preview stays opt-in, preserves fixtures, and leaves cleanup history unchanged.');
}

function assertOperationMeasurement(record) {
  const measurement = record.spaceMeasurement;
  assert.equal(measurement?.version, 1);
  assert.ok(['pending', 'comparable', 'unavailable', 'root-changed', 'volume-changed', 'not-run', 'interrupted'].includes(measurement.status));
  for (const sample of [measurement.before, measurement.after]) {
    if (sample === null) continue;
    assert.ok(Number.isSafeInteger(sample.measuredAt) && sample.measuredAt >= 0);
    assert.ok(Number.isSafeInteger(sample.total) && sample.total > 0);
    assert.ok(Number.isSafeInteger(sample.free) && sample.free >= 0 && sample.free <= sample.total);
  }
  if (measurement.status === 'comparable') {
    assert.ok(measurement.before && measurement.after);
    assert.equal(measurement.before.total, measurement.after.total);
    assert.ok(measurement.after.measuredAt >= measurement.before.measuredAt);
    assert.equal(record.freeSpaceDelta, measurement.after.free - measurement.before.free);
  } else assert.equal(record.freeSpaceDelta, null);
  return measurement;
}

function operationUI(id) {
  const record = [...document.querySelectorAll('article[data-record-id]')].find(node => node.getAttribute('data-record-id') === id);
  const section = record?.querySelector('section[aria-label="操作空间测量"], section[aria-label="Operation space measurement"]');
  if (!section) return null;
  const fields = element => Object.fromEntries([...element.querySelectorAll('dt')].map(term => [term.textContent.trim(), term.nextElementSibling?.textContent.trim()]));
  return {
    id: section.getAttribute('data-operation-id'), text: section.textContent,
    fields: fields(section), detailsOpen: section.querySelector('details')?.open,
    samples: [...section.querySelectorAll('article')].map(article => ({ name: article.getAttribute('aria-label'), fields: fields(article), dateTime: article.querySelector('time')?.dateTime })),
  };
}
async function showOperationMeasurement(record) {
  await clickButton(['Activity', '操作记录'], 'nav button');
  await waitForUI('operation measurement in activity', id => {
    const article = [...document.querySelectorAll('article[data-record-id]')].find(node => node.getAttribute('data-record-id') === id);
    return !!article?.querySelector('section[data-operation-id]');
  }, record.id);
  await render(id => {
    const article = [...document.querySelectorAll('article[data-record-id]')].find(node => node.getAttribute('data-record-id') === id);
    const section = article.querySelector('section[data-operation-id]');
    const details = section.querySelector('details');
    if (!details.open) details.querySelector('summary').click();
  }, record.id);
  return waitForUI('expanded operation measurement', id => {
    const article = [...document.querySelectorAll('article[data-record-id]')].find(node => node.getAttribute('data-record-id') === id);
    return article?.querySelector('section[data-operation-id] details')?.open;
  }, record.id);
}
async function setUILocale(locale) {
  const current = await render(() => document.documentElement.lang);
  if (current !== locale) await clickButton([locale === 'en' ? 'EN' : '中文'], '.language-button');
  await waitForUI('requested interface language', value => document.documentElement.lang === value, locale);
}
function expectedOperationSize(value, locale) {
  if (value === null || value === undefined) return locale === 'zh-CN' ? '未测得' : 'Not measured';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const power = value > 0 ? Math.min(5, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: power ? 1 : 0 }).format(value / 1024 ** power)} ${units[power]}`;
}
function assertOperationUI(ui, record, locale) {
  const t = (zh, en) => locale === 'zh-CN' ? zh : en;
  assert.equal(ui?.id, record.id);
  assert.equal(ui.detailsOpen, true);
  const measurement = record.spaceMeasurement;
  const delta = measurement && measurement.status !== 'comparable' ? null : record.freeSpaceDelta;
  const expectedDelta = delta === null ? t('无法比较', 'Cannot compare')
    : `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${expectedOperationSize(Math.abs(delta), locale)}`;
  assert.equal(ui.fields[t('操作前后可用空间变化', 'Available-space change before and after the operation')], expectedDelta);
  for (const [key, title] of [['before', t('操作前', 'Before the operation')], ['after', t('操作后', 'After the operation')]]) {
    const article = ui.samples.find(value => value.name === title);
    const sample = measurement?.[key];
    assert.ok(article, `Missing ${title} sample.`);
    assert.equal(article.fields[t('可用空间', 'Available space')], expectedOperationSize(sample?.free, locale));
    assert.equal(article.fields[t('卷总容量', 'Volume capacity')], expectedOperationSize(sample?.total, locale));
    if (sample) assert.equal(Date.parse(article.dateTime), sample.measuredAt);
    else assert.equal(article.fields[t('测量时间（本地）', 'Measured (local time)')], t('未测得', 'Not measured'));
  }
  if (!measurement) assert.ok(ui.text.includes(t('旧记录，未经卷身份核验', 'Legacy record; volume identity not verified')));
  const reasons = {
    comparable: ['两个测量时点可比较。', 'The two measurements are comparable.'],
    unavailable: ['未能取得完整的空间测量。', 'Complete space measurements were unavailable.'],
    'root-changed': ['扫描位置已变化或无法核对，不能比较。', 'The scan location changed or could not be verified; comparison is unavailable.'],
    'volume-changed': ['卷容量或文件系统信息变化，不能比较。', 'Volume capacity or filesystem information changed; comparison is unavailable.'],
    'not-run': ['操作未开始，未进行测量。', 'The operation did not start; no measurements were taken.'],
    interrupted: ['操作中断，没有完整的前后测量。', 'The operation was interrupted; before-and-after measurements are incomplete.'],
  };
  if (measurement && reasons[measurement.status]) assert.ok(ui.text.includes(t(...reasons[measurement.status])));
  assert.ok(ui.text.includes(t('不是盘清保证释放的空间', 'not space DiskHarbor guarantees it freed')));
  assert.ok(ui.text.includes(t('两者时段不同', 'it covers a different interval')));
}

async function operationSpaceChecks(realRecord) {
  const originalLocale = await render(() => document.documentElement.lang);
  for (const locale of ['zh-CN', 'en']) {
    await setUILocale(locale);
    await showOperationMeasurement(realRecord);
    assertOperationUI(await render(operationUI, realRecord.id), realRecord, locale);
  }
  report.checks.push('Activity displays the real operation’s before/after samples, timestamps and verified change in both interface languages.');

  const records = [];
  for (const name of ['comparable-positive', 'after-unavailable', 'volume-changed', 'root-replaced']) {
    const scenarioRoot = path.join(base, `operation-space-${name}`);
    const retainedRoot = `${scenarioRoot}-original`;
    const replacementRoot = `${scenarioRoot}-replacement`;
    await fs.mkdir(scenarioRoot);
    const itemPath = path.join(scenarioRoot, 'disposable.txt');
    await fs.writeFile(itemPath, `Synthetic operation-space fixture: ${name}.\n`);
    await scan(scenarioRoot);
    const entry = (await call('query', { kind: 'file' })).entries.find(value => value.path === itemPath);
    assert.ok(entry);
    const plan = await call('planCleanup', [entry.id]);
    assert.equal(plan.items[0].eligible, true, JSON.stringify(plan));
    const nativeTrash = shell.trashItem;
    let nativeCalls = 0;
    statfsScenario = name === 'root-replaced' ? null : { name, rootPath: scenarioRoot, calls: 0 };
    shell.trashItem = async target => {
      assert.equal(target, itemPath, 'Native operation must target only this synthetic file.');
      nativeCalls++;
      await nativeTrash(target);
      if (name === 'root-replaced') {
        await fs.rename(scenarioRoot, retainedRoot);
        await fs.mkdir(scenarioRoot);
        await fs.writeFile(path.join(scenarioRoot, 'replacement.txt'), 'A replacement synthetic root.\n');
      }
    };
    let record;
    try { record = await call('executeCleanup', plan.id, 'en'); }
    finally { shell.trashItem = nativeTrash; statfsScenario = null; }
    assert.equal(nativeCalls, 1);
    assert.equal(record.success, 1, JSON.stringify(record));
    assert.equal(record.failed, 0);
    assert.equal(record.items[0].status, 'trashed');
    assert.equal(await exists(itemPath), false);
    const measurement = assertOperationMeasurement(record);
    const expectedStatus = { 'comparable-positive': 'comparable', 'after-unavailable': 'unavailable', 'volume-changed': 'volume-changed', 'root-replaced': 'root-changed' }[name];
    assert.equal(measurement.status, expectedStatus);
    if (name === 'comparable-positive') assert.equal(record.freeSpaceDelta, 409600);
    if (name === 'after-unavailable' || name === 'root-replaced') assert.equal(measurement.after, null);
    if (name === 'root-replaced') {
      await fs.rename(scenarioRoot, replacementRoot);
      await fs.rename(retainedRoot, scenarioRoot);
      assert.equal(await fs.readFile(path.join(replacementRoot, 'replacement.txt'), 'utf8'), 'A replacement synthetic root.\n');
    }
    await showOperationMeasurement(record);
    assertOperationUI(await render(operationUI, record.id), record, 'en');
    records.push({ scenario: name, id: record.id, success: record.success, measurementStatus: measurement.status, delta: record.freeSpaceDelta });
  }
  report.operationSpaceFixtures = records;
  report.checks.push('Explicit statfs fixtures and a real temporary root replacement preserve native item outcomes while classifying comparable, unavailable, changed-volume and changed-root observations.');
  await setUILocale(originalLocale);
}

async function coldStartChecks() {
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.match(window.webContents.getURL(), /^diskharbor:\/\/app\//);
  assert.equal(await call('summary'), null);
  const expected = JSON.parse(await fs.readFile(path.join(base, 'cold-expected.json'), 'utf8'));
  const records = await call('history');
  for (const record of expected) assert.deepEqual(records.find(value => value.id === record.id), record);
  report.checks.push('A second real Electron process reloads every completed native operation with its durable space samples and comparison status unchanged.');
  const legacy = records.find(value => value.id === 'synthetic-legacy-space');
  assert.ok(legacy && !('spaceMeasurement' in legacy));
  assert.equal(legacy.freeSpaceDelta, 131072);
  const interrupted = records.find(value => value.id === 'synthetic-interrupted-space');
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.items[0].status, 'unknown');
  assert.equal(interrupted.items[1].status, 'cancelled');
  assert.equal(interrupted.spaceMeasurement.status, 'interrupted');
  assert.equal(interrupted.spaceMeasurement.before.free, 400000);
  assert.equal(interrupted.spaceMeasurement.after, null);
  assert.equal(interrupted.freeSpaceDelta, null);
  for (const locale of ['zh-CN', 'en']) {
    await setUILocale(locale);
    for (const record of [legacy, interrupted]) {
      await showOperationMeasurement(record);
      assertOperationUI(await render(operationUI, record.id), record, locale);
    }
  }
  assert.equal(operationStatfsReads.length, 0, 'Cold history loading must not remeasure or infer a missing observation.');
  assert.equal(coldTrashCalls, 0);
  assert.equal(await call('summary'), null);
  const durable = JSON.parse(await fs.readFile(historyPath, 'utf8'));
  assert.equal(durable.find(value => value.id === interrupted.id).spaceMeasurement.after, null);
  report.checks.push('Clearly synthetic legacy history retains its unverified warning; interrupted history discards its after sample and delta on cold recovery in both languages.');
  assert.deepEqual(report.errors, []);
}

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
  const readsBeforeCancel = operationStatfsReads.length;
  const cancelResult = await call('executeCleanup', cancelled.id, 'en');
  assert.equal(cancelResult.items[0].status, 'cancelled');
  assert.equal(await exists(path.join(root, 'first.txt')), true);
  assert.equal(lastDialog.buttons[0], 'Cancel');
  assert.equal(assertOperationMeasurement(cancelResult).status, 'not-run');
  assert.equal(cancelResult.spaceMeasurement.before, null);
  assert.equal(cancelResult.spaceMeasurement.after, null);
  assert.equal(operationStatfsReads.length, readsBeforeCancel);
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
  const readsBeforeMove = operationStatfsReads.filter(value => value.rootPath === root).length;
  const moved = await call('executeCleanup', current.id, 'en');
  assert.equal(moved.success, 1, JSON.stringify(moved));
  assert.equal(await exists(path.join(root, 'sample-folder')), false);
  report.checks.push('Real native directory Trash operation succeeds.');
  const realMeasurement = assertOperationMeasurement(moved);
  assert.ok(['comparable', 'unavailable'].includes(realMeasurement.status), JSON.stringify(realMeasurement));
  assert.equal(operationStatfsReads.filter(value => value.rootPath === root).length - readsBeforeMove, 2);
  report.realOperationSpace = realMeasurement;
  report.checks.push('A real native directory operation attempts both genuine volume samples and exposes a numeric change only when they are comparable.');
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
  assertOperationMeasurement(partial);
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
  await previewChecks();
  await operationSpaceChecks(moved);
  const durableRecords = await call('history');
  for (const record of durableRecords) assertOperationMeasurement(record);
  await fs.writeFile(path.join(base, 'cold-expected.json'), JSON.stringify(durableRecords, null, 2));
  report.phases = { primary: 'passed', reload: 'pending' };
  assert.deepEqual(report.errors, []);
}

try {
  if (coldStart) {
    const saved = JSON.parse(fsSync.readFileSync(historyPath, 'utf8'));
    const seededAt = Date.now() - 1000;
    // Deliberate test journal fixtures, never reports of real cleanup actions.
    saved.push({
      id: 'synthetic-legacy-space', time: seededAt, rootPath: path.join(base, 'synthetic-legacy-journal'),
      state: 'completed', success: 0, failed: 0, freeSpaceDelta: 131072,
      items: [{ path: path.join(base, 'synthetic-legacy-item'), status: 'cancelled' }],
    }, {
      id: 'synthetic-interrupted-space', time: seededAt, rootPath: path.join(base, 'synthetic-interrupted-journal'),
      state: 'running', success: 0, failed: 0, freeSpaceDelta: 100000,
      spaceMeasurement: { version: 1, status: 'comparable',
        before: { measuredAt: seededAt, total: 1000000, free: 400000 },
        after: { measuredAt: seededAt + 1, total: 1000000, free: 500000 } },
      items: [{ path: path.join(base, 'synthetic-processing-item'), status: 'processing' }, { path: path.join(base, 'synthetic-pending-item'), status: 'pending' }],
    });
    fsSync.writeFileSync(historyPath, JSON.stringify(saved, null, 2));
    originalTrash = shell.trashItem;
    shell.trashItem = async () => { coldTrashCalls++; throw new Error('Cold journal recovery must never call Trash.'); };
  } else {
    fsSync.mkdirSync(path.join(root, 'sample-folder', 'nested'), { recursive: true });
    fsSync.mkdirSync(userData, { recursive: true });
    fsSync.mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
    fsSync.writeFileSync(path.join(root, 'sample-folder', 'nested', 'nested.txt'), 'Nested smoke fixture.');
    fsSync.writeFileSync(path.join(root, 'first.txt'), 'First smoke fixture.');
    fsSync.writeFileSync(path.join(root, 'second.txt'), 'Second smoke fixture.');
    fsSync.writeFileSync(historyPath, JSON.stringify([{
      id: 'interrupted-fixture', planId: 'old-plan', time: Date.now(), rootPath: root,
      state: 'running', success: 0, failed: 0, freeSpaceDelta: null,
      items: [{ path: path.join(root, 'first.txt'), status: 'processing' }, { path: path.join(root, 'second.txt'), status: 'pending' }],
    }]));
  }
  app.on('browser-window-created', (_event, created) => {
    if (window) return;
    window = created;
    window.webContents.on('console-message', (_event, details) => {
      if (details.level === 'error') report.errors.push(details.message);
    });
    window.webContents.once('did-finish-load', () => {
      ipcMain.handle = originalHandle;
      (coldStart ? coldStartChecks() : execute()).then(() => {
        if (coldStart) report.phases.reload = 'passed';
        return finish();
      }, finish);
    });
  });
  require('../electron/main.cjs');
} catch (error) { void finish(error); }
