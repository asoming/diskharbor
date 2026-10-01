'use strict';

// The production app, native scanner and renderer run unchanged. Only this
// process's accessibility bridge is enabled and its disposable profile set.
const { app, shell } = require('electron');
const { execFile, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const run = promisify(execFile);
const base = process.env.DISKHARBOR_ACCESSIBILITY_DIR;
assert.ok(base && path.isAbsolute(base) && path.basename(base).startsWith('accessibility-acceptance-'));
assert.equal(process.env.AT_SPI_BUS_ADDRESS, `unix:abstract=${path.basename(base)}`);
assert.equal(process.env.DISKHARBOR_PRIVATE_ATSPI, process.env.AT_SPI_BUS_ADDRESS);
const root = path.join(base, 'scan-fixture');
const folder = path.join(root, 'Owned folder');
const file = path.join(folder, 'Read me.txt');
const content = 'Disposable accessibility acceptance fixture.\n';
const project = path.resolve(__dirname, '..');
const fingerprint = directory => fsSync.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const filename = path.join(directory, entry.name);
  return entry.isDirectory() ? fingerprint(filename) : [{ file: path.relative(project, filename), sha256: createHash('sha256').update(fsSync.readFileSync(filename)).digest('hex') }];
});
const report = { platform: process.platform, session: process.env.XDG_SESSION_TYPE || 'unknown', electron: process.versions.electron,
  source: { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' }).trim(), rendererFiles: fingerprint(path.join(project, 'dist')) },
  nativeBridge: 'AT-SPI', manualScreenReader: 'not-performed', checks: [], errors: [], snapshots: [],
  limitations: ['No Orca speech/listening test was performed.', 'Windows UIA/NVDA and macOS VoiceOver were not tested.', 'The accessibility bridge is enabled explicitly in this isolated process; automatic screen-reader detection is not validated.'] };
let window;
let finishing = false;
let trashCalls = 0;
shell.trashItem = async () => { trashCalls += 1; throw new Error('Accessibility acceptance must never move files to Trash.'); };
app.setPath('userData', path.join(base, 'user-data'));
app.setPath('sessionData', path.join(base, 'user-data', 'session'));
app.commandLine.appendSwitch('force-renderer-accessibility');
const watchdog = setTimeout(() => finish(new Error('Accessibility acceptance timed out.')), 90000);

async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  report.result = error ? 'failed' : 'passed';
  report.trashCalls = trashCalls;
  if (error) report.error = String(error.stack || error);
  await fs.writeFile(path.join(base, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(error ? 1 : 0);
}
function render(fn, ...args) { return window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`); }
async function waitFor(label, read) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(`Timed out: ${label}`);
}
async function button(name) {
  await waitFor(`button ${name}`, () => render(label => {
    const node = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === label || item.getAttribute('aria-label') === label);
    if (!node || node.disabled || !node.getClientRects().length) return false;
    node.focus(); node.click(); return true;
  }, name));
}
async function key(keyCode, modifiers = []) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await new Promise(resolve => setTimeout(resolve, 100));
}
async function snapshot(name, ready = () => true) {
  let observation;
  let attempts = 0;
  await waitFor(`native accessibility state ${name}`, async () => {
    const { stdout } = await run(process.env.DISKHARBOR_ATSPI_PYTHON, [path.join(__dirname, '..', 'scripts', 'accessibility-acceptance-observer.py'), String(process.pid)], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }).catch(error => { throw new Error(`Native AT-SPI observation failed: ${error.stdout || error.message}`); });
    observation = JSON.parse(stdout);
    assert.equal(observation.nativeBridge, 'AT-SPI');
    assert.equal(observation.pid, process.pid);
    attempts += 1;
    await fs.writeFile(path.join(base, `${name}-latest.json`), JSON.stringify(observation, null, 2));
    return ready(observation.nodes);
  });
  await fs.writeFile(path.join(base, `${name}.json`), JSON.stringify(observation, null, 2));
  report.snapshots.push({ name, nodes: observation.nodes.length, attempts });
  return observation.nodes;
}
function find(nodes, name, role) { return nodes.find(node => node.name === name && (!role || node.role === role)); }
function beneath(nodes, node, ancestor) {
  let parent = node.parent;
  while (parent !== null) { if (parent === ancestor.id) return true; parent = nodes[parent].parent; }
  return false;
}

async function execute() {
  window.show(); window.focus();
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  await waitFor('scan field', () => render(target => {
    const input = document.querySelector('input[aria-label="扫描路径"]');
    if (!input || input.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, target);
    input.dispatchEvent(new Event('input', { bubbles: true })); return true;
  }, root));
  const initial = await snapshot('01-zh-start', nodes => !!find(nodes, '扫描路径'));
  assert.ok(find(initial, '扫描路径'));
  assert.ok(find(initial, '开始扫描', 'push button'));
  report.checks.push('Native AT-SPI exposes the Chinese scan path and named scan action from the owned application PID.');
  await button('开始扫描');
  await waitFor('real scan complete', () => render(() => document.querySelector('.scan-status')?.textContent.includes('扫描完成')));
  await button('打开文件树');
  await waitFor('file tree', () => render(() => document.querySelector('[role="treegrid"]')?.getAttribute('aria-busy') === 'false' && document.querySelector('.fx-filename')?.textContent === 'Owned folder'));
  await render(() => document.querySelector('[role="treegrid"]').focus());
  await key('Home');
  const collapsed = await snapshot('02-zh-tree-collapsed', nodes => !!find(nodes, '文件树', 'tree table'));
  const tree = find(collapsed, '文件树', 'tree table');
  assert.ok(tree);
  assert.match(tree.description, /方向键/);
  assert.ok(collapsed.some(node => node.states.includes('expandable') && !node.states.includes('expanded') && beneath(collapsed, node, tree)));
  assert.ok(find(collapsed, '名称', 'column header'));
  await key('Right');
  await waitFor('expanded folder contents', () => render(() => [...document.querySelectorAll('.fx-filename')].some(node => node.textContent === 'Read me.txt')));
  const expanded = await snapshot('03-zh-tree-expanded', nodes => !!find(nodes, 'Read me.txt'));
  assert.ok(expanded.some(node => node.states.includes('expanded')));
  assert.ok(find(expanded, 'Read me.txt'));
  report.checks.push('Native AT-SPI exposes tree instructions, headers, collapsed/expanded state and child filename after a real arrow-key expansion.');
  await key('Down');
  await key('Space');
  await waitFor('selection', () => render(() => document.querySelector('.fx-row[aria-selected="true"] .fx-filename')?.textContent === 'Read me.txt'));
  const selected = await snapshot('04-zh-selected', nodes => nodes.some(node => node.role === 'check box' && node.name === '选择项目: Read me.txt' && node.states.includes('checked')));
  assert.ok(selected.some(node => node.role === 'check box' && node.name === '选择项目: Read me.txt' && node.states.includes('checked')));
  report.checks.push('Keyboard selection reaches the native bridge as a checked file selection control.');
  await button('查看 1 项');
  await waitFor('review dialog', () => render(() => !!document.querySelector('[role="dialog"]')));
  const review = await snapshot('05-zh-review', nodes => !!find(nodes, '核对文件与文件夹', 'dialog'));
  const dialog = find(review, '核对文件与文件夹', 'dialog');
  assert.ok(dialog);
  assert.ok(dialog.states.includes('modal'));
  assert.match(dialog.description, /系统回收站/);
  assert.ok(review.some(node => node.states.includes('focused') && beneath(review, node, dialog)));
  assert.ok(find(review, file));
  for (const modifiers of [[], ['shift'], [], []]) {
    await key('Tab', modifiers);
    assert.equal(await render(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), true);
  }
  await key('Escape');
  await waitFor('closed review', () => render(() => !document.querySelector('[role="dialog"]')));
  assert.equal(await render(() => document.activeElement?.textContent.trim()), '查看 1 项');
  report.checks.push('Native AT-SPI exposes a named modal review, impact description, complete fixture path and focus; Tab stays inside and Escape returns focus without cleanup.');
  await button('切换为英文');
  await waitFor('English tree', () => render(() => document.querySelector('[role="treegrid"]')?.getAttribute('aria-label') === 'File tree'));
  const english = await snapshot('06-en-tree', nodes => !!find(nodes, 'File tree', 'tree table'));
  assert.ok(find(english, 'File tree', 'tree table'));
  assert.match(find(english, 'File tree', 'tree table').description, /arrow keys/);
  assert.ok(find(english, 'Search scanned items'));
  await button('Review 1');
  const englishReview = await snapshot('07-en-review', nodes => !!find(nodes, 'Review files and folders', 'dialog'));
  const englishDialog = find(englishReview, 'Review files and folders', 'dialog');
  assert.ok(englishDialog);
  assert.match(englishDialog.description, /system Trash/);
  assert.ok(englishDialog.states.includes('modal'));
  await key('Escape');
  assert.equal(await fs.readFile(file, 'utf8'), content);
  assert.equal(trashCalls, 0);
  assert.deepEqual(report.errors, []);
  report.checks.push('English tree and review names/descriptions are exposed through AT-SPI; fixture content is unchanged and the Trash API is never called.');
}

try {
  fsSync.mkdirSync(folder, { recursive: true });
  fsSync.writeFileSync(file, content);
  app.whenReady().then(() => app.setAccessibilitySupportEnabled(true));
  app.on('browser-window-created', (_event, created) => {
    if (window) return;
    window = created;
    window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') report.errors.push(details.message); });
    window.webContents.once('did-finish-load', () => execute().then(() => finish(), finish));
  });
  require('../electron/main.cjs');
} catch (error) { void finish(error); }
