'use strict';
// Real production scanner/IPC/SVG, only owned files. The sole response hold
// exercises stale-view rejection; no chart data or sizes are projected.
const { app, ipcMain, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.env.DISKHARBOR_CHART_SMOKE_DIR;
assert(base && path.isAbsolute(base) && path.basename(base).startsWith('charts-smoke-'));
const root = path.join(base, '图表测试 📊');
const replacement = path.join(base, 'replacement');
const userData = path.join(base, 'profile');
const report = { platform: process.platform, checks: [], errors: [], screenshots: [], requests: [], trashCalls: 0 };
const handle = ipcMain.handle;
let window, finishing = false, holdNext = false, held, release;
ipcMain.handle = function (channel, listener) {
  if (channel !== 'diskharbor:chart') return handle.call(this, channel, listener);
  return handle.call(this, channel, async (event, scanId, options) => {
    const holding = holdNext; holdNext = false;
    const result = await listener(event, scanId, options);
    report.requests.push({ scanId, options, totalBytes: result.totalBytes, holding });
    if (holding) { held = result; await new Promise(resolve => { release = resolve; }); }
    return result;
  });
};
shell.trashItem = async () => { report.trashCalls++; throw new Error('Charts must never call Trash'); };
app.setPath('userData', userData); app.setPath('sessionData', path.join(userData, 'session'));
app.commandLine.appendSwitch('disable-gpu');
const watchdog = setTimeout(() => finish(new Error('Chart smoke timed out')), 90000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (method, ...args) => window.webContents.executeJavaScript(`window.diskharbor[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
const render = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
async function wait(description, read) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(25); }
  throw new Error(`Chart wait failed: ${description}`);
}
function click(labels, selector = 'button') {
  return wait(`button ${labels}`, () => render((names, scope) => {
    const button = [...document.querySelectorAll(scope)].find(node => names.includes(node.textContent.trim()) || names.includes(node.getAttribute('aria-label')));
    if (!button || button.disabled) return false;
    button.scrollIntoView({ block: 'nearest' }); button.focus(); button.click(); return true;
  }, labels, selector));
}
const currentScope = () => render(() => document.querySelector('.chart-breadcrumbs [aria-current=location]')?.title);
async function scan(target) {
  const previous = await call('summary');
  await wait('scan input', () => render(value => {
    const input = document.querySelector('.scan-toolbar input'); if (!input || input.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); return true;
  }, target));
  await click(['开始扫描', 'Start scan', '重新扫描', 'Scan again'], '.scan-toolbar button');
  return wait('completed new scan', async () => {
    const value = await call('summary');
    if (value?.state === 'error') throw new Error(value.message);
    return value?.state === 'completed' && value.scanId !== previous?.scanId ? value : false;
  });
}
async function setMetric(metric, waitForLoaded = true) {
  await render(value => { const select = document.querySelector('.chart-metric select'); select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }, metric);
  if (waitForLoaded) await wait('chart loaded in measure', () => render(value => document.querySelector('.chart-metric select')?.value === value && !!document.querySelector('.chart-details table'), metric));
}
async function screenshot(name) {
  await render(() => document.querySelector('.chart-toolbar')?.scrollIntoView({ block: 'start' }));
  await pause(350);
  const image = await window.webContents.capturePage();
  await fs.writeFile(path.join(base, `${name}.png`), image.toPNG()); report.screenshots.push(`${name}.png`);
}
async function execute() {
  window.show(); window.focus(); window.webContents.focus();
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false);
  await assert.rejects(call('chart', 'no-scan', { entryId: 1, metric: 'allocated', includeHidden: false, includeSystem: false }), /NO_SCAN/);
  const summary = await scan(root);
  await click(['空间图表', 'Storage charts'], 'nav button');
  await wait('chart root', async () => await currentScope() === root);
  const options = { entryId: summary.rootId, metric: 'allocated', includeHidden: false, includeSystem: false };
  const data = await call('chart', summary.scanId, options);
  report.initial = { scanId: summary.scanId, totalBytes: data.totalBytes, childCount: data.childCount, limits: data.limits };
  assert.equal(data.totalBytes, summary.scannedBytes);
  assert.equal(data.nodes.reduce((n, node) => n + node.value, 0), data.totalBytes);
  assert(data.nodes.some(node => node.group === 'other')); assert(data.nodes.some(node => node.group === 'hidden'));
  assert(data.nodes.length <= 26);
  for (const node of data.nodes) if (node.children) assert.equal(node.children.reduce((n, child) => n + child.value, 0), node.value);
  assert(await render(() => !!document.querySelector('.chart-treemap') && document.querySelector('.chart-area').dataset.chartType === 'treemap'));
  report.checks.push('Production sandbox chart metadata matches full scan bytes, grouped remainder and hidden bytes; two-level data is bounded and nonduplicated.');
  await screenshot('treemap-zh');

  await click(['饼图', 'Pie'], '.chart-switch button');
  const positive = data.nodes.filter(node => node.value > 0);
  assert.equal(await render(() => document.querySelectorAll('.chart-pie path').length), positive.length);
  assert(await render(() => [...document.querySelectorAll('.chart-pie path')].every(node => !!node.querySelector('title')?.textContent && !node.getAttribute('d').includes('NaN'))));
  await screenshot('pie-zh');
  await click(['条形图', 'Bar'], '.chart-switch button');
  assert.equal(await render(() => document.querySelectorAll('.chart-bar').length), positive.length);
  assert(await render(() => [...document.querySelectorAll('.chart-bar-track i')].every(node => parseFloat(node.style.width) > 0 && parseFloat(node.style.width) <= 100)));
  await screenshot('bar-zh');
  report.checks.push('Real pie slices and bar widths cover every positive aggregate; tooltips, names, size and shares remain available as an HTML table.');

  const before = report.requests.length;
  await setMetric('logical');
  await wait('logical query recorded', () => report.requests.slice(before).some(item => item.options.metric === 'logical'));
  const logical = await call('chart', summary.scanId, { ...options, metric: 'logical' });
  assert.equal(logical.totalBytes, summary.logicalBytes);
  assert.equal(logical.nodes.reduce((n, node) => n + node.value, 0), summary.logicalBytes);
  report.checks.push('Switching to logical bytes uses actual logical metadata; no allocation fallback or volume free slice is mixed into directory totals.');

  await click(['面积树图', 'Treemap'], '.chart-switch button');
  const folder = data.nodes.find(node => node.entry?.name === '视频'); assert(folder);
  await render(id => {
    const button = document.querySelector(`[data-chart-key="entry:${id}"] button`); button.scrollIntoView({ block: 'center' }); button.focus();
    window.__chartKeyEvents = [];
    button.addEventListener('keydown', event => window.__chartKeyEvents.push({ key: event.key, code: event.code, trusted: event.isTrusted }));
  }, folder.entry.id);
  await pause(100);
  report.beforeKeyboard = await render(() => ({ active: document.activeElement.outerHTML, documentFocused: document.hasFocus() }));
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await pause(100);
  report.nativeKeyEvents = await render(() => window.__chartKeyEvents);
  await wait('keyboard drilled folder', async () => await currentScope() === path.join(root, '视频'));
  await wait('focus restored to current chart heading', () => render(() => document.activeElement === document.querySelector('.chart-heading h2')));
  const child = await call('chart', summary.scanId, { ...options, metric: 'logical', entryId: folder.entry.id });
  assert.equal(child.totalBytes, 3 * 1024 * 1024 + 128 * 1024);
  await click(['上一级', 'Up'], '.chart-actions button');
  await wait('returned root', async () => await currentScope() === root);
  report.checks.push('Native keyboard Enter drills into the indexed Unicode directory, focuses its heading, and Up restores the root without rescanning.');

  const file = logical.nodes.find(node => node.entry?.name === '安装包.zip'); assert(file);
  await render(id => document.querySelector(`[data-chart-key="entry:${id}"] button`).click(), file.entry.id);
  await wait('chart file resolves in tree', () => render(expected => document.querySelector('.detail-path')?.textContent === expected && !!document.querySelector('[role=treegrid]'), file.entry.path));
  assert.equal((await call('summary')).scanId, summary.scanId);
  await click(['空间图表', 'Storage charts'], 'nav button');
  await wait('charts remounted', async () => await currentScope() === root);
  await render(() => document.querySelectorAll('.view-filters input')[0].click());
  await wait('hidden row visible', () => render(() => [...document.querySelectorAll('.chart-details th button')].some(node => node.textContent.includes('.隐藏资料'))));
  assert.equal((await call('chart', summary.scanId, { ...options, includeHidden: true })).totalBytes, summary.scannedBytes);
  report.checks.push('Chart files navigate to their exact indexed tree entry; display filters reveal hidden rows without changing full totals or cleanup policy.');

  await click(['切换为英文', 'Switch to Chinese']);
  await wait('English chart labels', () => render(() => document.documentElement.lang === 'en' && !![...document.querySelectorAll('.chart-switch button')].find(node => node.textContent === 'Treemap')));
  window.setContentSize(1024, 700);
  await wait('minimum content width', () => render(() => innerWidth === 1024));
  window.webContents.setZoomFactor(2);
  await wait('200 percent renderer geometry', () => render(() => innerWidth === 512));
  await render(() => document.querySelector('.chart-details summary').scrollIntoView({ block: 'center' })); await pause(250);
  const geometry = await render(() => ({ width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
    chart: document.querySelector('.disk-charts').getBoundingClientRect().toJSON(), table: document.querySelector('.chart-details table').getBoundingClientRect().toJSON() }));
  assert(geometry.documentWidth <= geometry.width); assert(geometry.table.right <= geometry.width + 1);
  report.geometry = geometry;
  await screenshot('treemap-en-200');
  await click(['Switch to Chinese']);
  await wait('Chinese at 200 percent', () => render(() => document.documentElement.lang === 'zh-CN' && !!document.querySelector('.chart-treemap')));
  await screenshot('treemap-zh-200');
  window.webContents.setZoomFactor(1); window.setContentSize(1320, 880);
  report.checks.push('Chinese and English controls/table fit the minimum window at 200% with no root horizontal overflow.');

  await assert.rejects(call('chart', summary.scanId, { ...options, metric: 'free' }), /INVALID_QUERY/);
  await assert.rejects(call('chart', summary.scanId, { ...options, includeHidden: 'yes' }), /INVALID_QUERY/);
  await assert.rejects(call('chart', summary.scanId, { ...options, entryId: 9999999 }), /ENTRY_UNAVAILABLE/);
  holdNext = true; await setMetric('logical', false);
  await wait('real old-scan response held', () => held);
  const next = await scan(replacement);
  await wait('new chart root', async () => await currentScope() === replacement);
  release(); release = null; await pause(200);
  assert.equal(await currentScope(), replacement);
  assert.equal(await render(() => document.querySelector('.chart-details table').textContent.includes('安装包.zip')), false);
  await assert.rejects(call('chart', summary.scanId, options), /SCAN_CHANGED/);
  report.checks.push('Invalid measures/types/IDs and old scan tokens are refused; a held real old response cannot overwrite a replacement scan.');
  await scan(path.join(base, 'empty'));
  await wait('empty chart state', () => render(() => document.querySelector('.chart-empty')?.textContent.includes('没有可绘制')));
  assert.equal(await render(() => document.querySelectorAll('.chart-slice, .chart-bar, .chart-tile').length), 0);
  assert.equal(next.files, 1);
  assert.equal(report.trashCalls, 0); assert.deepEqual(await call('history'), []);
  assert.equal((await fs.stat(path.join(root, '视频', '电影.bin'))).size, 3 * 1024 * 1024);
  assert.equal(await fs.readFile(path.join(replacement, 'only.txt'), 'utf8'), 'replacement only');
  report.checks.push('Empty directories draw no invented area; all fixtures and history stay unchanged, with zero Trash calls.');
}
async function finish(error) {
  if (finishing) return; finishing = true; clearTimeout(watchdog); release?.();
  report.result = error ? 'failed' : 'passed';
  if (error) {
    report.errors.push(String(error.stack || error));
    if (window && !window.isDestroyed()) {
      report.ui = await render(() => document.body.innerText).catch(() => 'unavailable');
      await fs.writeFile(path.join(base, 'failure.png'), (await window.webContents.capturePage()).toPNG()).catch(() => {});
    }
  }
  await fs.writeFile(path.join(base, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); app.exit(error ? 1 : 0);
}
const fixtureReady = (async () => {
  await fs.mkdir(path.join(root, '视频'), { recursive: true }); await fs.mkdir(path.join(root, '文档'), { recursive: true });
  await fs.mkdir(replacement, { recursive: true }); await fs.mkdir(path.join(base, 'empty'), { recursive: true });
  await fs.writeFile(path.join(root, '视频', '电影.bin'), Buffer.alloc(3 * 1024 * 1024));
  await fs.writeFile(path.join(root, '视频', '片段.txt'), Buffer.alloc(128 * 1024));
  await fs.writeFile(path.join(root, '文档', '报告.txt'), Buffer.alloc(512 * 1024));
  await fs.writeFile(path.join(root, '安装包.zip'), Buffer.alloc(1024 * 1024));
  await fs.writeFile(path.join(root, '.隐藏资料'), Buffer.alloc(1024 * 1024));
  await fs.writeFile(path.join(root, 'empty.txt'), '');
  for (let n = 0; n < 36; n++) await fs.writeFile(path.join(root, `小文件-${n}.txt`), `fixture ${n}`);
  await fs.writeFile(path.join(replacement, 'only.txt'), 'replacement only');
})();
fixtureReady.catch(finish);
app.on('browser-window-created', (_event, value) => {
    if (window) return; window = value;
    window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') report.errors.push(details.message); });
    window.webContents.once('did-finish-load', () => fixtureReady.then(execute).then(() => { assert.deepEqual(report.errors, []); return finish(); }, finish).catch(finish));
  });
require('../electron/main.cjs');
