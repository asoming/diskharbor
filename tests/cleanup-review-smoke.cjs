'use strict';

// The Windows branch uses genuine attrib +H/+S fixtures and production policy.
// Elsewhere only the renderer-facing hidden eligibility is projected by this
// temporary harness; no production bypass or native-Windows claim is involved.
// Every native confirmation is cancelled. Any Trash call is a test failure.
const { app, ipcMain, dialog, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const base = process.env.DISKHARBOR_REVIEW_SMOKE_DIR;
assert.ok(base && path.isAbsolute(base) && path.basename(base).startsWith('cleanup-review-smoke-'));
const root = path.join(base, 'files');
const otherRoot = path.join(base, 'replacement');
const hiddenFile = path.join(root, 'ordinary-hidden.txt');
const protectedFile = path.join(root, process.platform === 'win32' ? 'system-hidden.txt' : '.protected-settings');
const userData = path.join(base, 'user-data');
const report = {
  platform: process.platform, checks: [], errors: [], requests: [], confirmations: [],
  nativeHiddenAttributes: process.platform === 'win32',
  boundary: process.platform === 'win32'
    ? 'Real Windows hidden/system attributes on self-created files; production scanner, cleanup policy, IPC and renderer. Native confirmations are cancelled.'
    : 'Real scanner, IPC and renderer. A test-only response projection exercises Windows hidden-review UI; it does not validate native Windows metadata on this platform. Native confirmations are cancelled.',
};
const originalHandle = ipcMain.handle;
const originalTrash = shell.trashItem;
const originalDialog = dialog.showMessageBox;
let window;
let finishing = false;
let nextResponse;
let heldResponse;
let releaseResponse;
let trashCalls = 0;
let executions = 0;

ipcMain.handle = function (channel, listener) {
  if (channel === 'diskharbor:executeCleanup') return originalHandle.call(this, channel, (event, ...args) => {
    executions += 1;
    return listener(event, ...args);
  });
  if (channel !== 'diskharbor:planCleanup') return originalHandle.call(this, channel, listener);
  return originalHandle.call(this, channel, async (event, ids, options) => {
    const control = nextResponse; nextResponse = undefined;
    let result = await listener(event, ids, options);
    if (process.platform !== 'win32' && result.items.some(item => item.path === hiddenFile)) {
      const allowHidden = options?.allowHidden === true;
      result = { ...result, allowHidden, hiddenReviewAvailable: true,
        items: result.items.map(item => item.path === hiddenFile
          ? { ...item, eligible: allowHidden && item.eligible, reason: allowHidden ? item.reason : 'HIDDEN_PATH' } : item) };
      result.totalBytes = result.items.filter(item => item.eligible).reduce((sum, item) => sum + item.size, 0);
    }
    const request = { ids, options: options ?? null, planId: result.id, allowHidden: result.allowHidden,
      hiddenReviewAvailable: result.hiddenReviewAvailable, eligible: result.items.filter(item => item.eligible).length,
      paths: result.items.map(item => item.path), control: control || 'normal', returned: false };
    report.requests.push(request);
    if (control === 'reject') throw new Error('SYNTHETIC_REVIEW_FAILURE');
    if (control === 'hold') {
      heldResponse = request;
      await new Promise(resolve => { releaseResponse = resolve; });
    }
    request.returned = true;
    return result;
  });
};
shell.trashItem = async () => { trashCalls += 1; throw new Error('Review smoke must never move any file to Trash.'); };
dialog.showMessageBox = async (_owner, options) => {
  assert.ok(options.detail.includes(hiddenFile), 'Native confirmation must concern only the selected fixture.');
  assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
  report.confirmations.push({ detail: options.detail, buttons: options.buttons, response: 0 });
  return { response: 0 };
};
app.setPath('userData', userData);
app.setPath('sessionData', path.join(userData, 'session'));
app.commandLine.appendSwitch('disable-gpu');
const watchdog = setTimeout(() => finish(new Error('Cleanup review smoke timed out.')), 90000);

function call(method, ...args) { return window.webContents.executeJavaScript(`window.diskharbor[${JSON.stringify(method)}](...${JSON.stringify(args)})`); }
function render(read, ...args) { return window.webContents.executeJavaScript(`(${read.toString()})(...${JSON.stringify(args)})`); }
async function waitFor(description, read) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Cleanup review wait failed: ${description}`);
}
function waitUI(description, read, ...args) { return waitFor(description, () => render(read, ...args)); }
async function settle() { await render(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function clickButton(names, scope = 'button') {
  await waitUI(`enabled button ${names.join(' / ')}`, (labels, selector) => {
    const button = [...document.querySelectorAll(selector)].find(node => labels.includes(node.textContent.trim()));
    if (!button || button.disabled || !button.getClientRects().length) return false;
    button.focus({ preventScroll: true }); button.click(); return true;
  }, names, scope);
}
function reviewUI() {
  const modal = document.querySelector('.review-modal');
  if (!modal) return null;
  const checkbox = modal.querySelector('input[type="checkbox"]');
  const continuation = [...modal.querySelectorAll('button')].find(node => ['继续并由系统确认', 'Continue to confirmation'].includes(node.textContent.trim()));
  return { text: modal.textContent, checked: checkbox?.checked ?? null, disabled: checkbox?.disabled ?? null,
    focusedCheckbox: checkbox === document.activeElement, continueDisabled: continuation?.disabled,
    updating: !!modal.querySelector('.review-update-status'), error: modal.querySelector('[role="alert"]')?.textContent ?? null,
    blocked: modal.querySelector('#review-blocked-help')?.textContent ?? null,
    width: modal.clientWidth, scrollWidth: modal.scrollWidth, height: modal.clientHeight,
    scrollHeight: modal.scrollHeight, overflowY: getComputedStyle(modal).overflowY };
}
async function scan(target, viaBridge = false) {
  const previous = await call('summary');
  if (viaBridge) await call('startScan', target);
  else {
    await waitUI('editable scan path', value => {
      const input = document.querySelector('input[aria-label="Scan path"], input[aria-label="扫描路径"]');
      if (!input || input.disabled) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true })); return true;
    }, target);
    await clickButton(['Start scan', '开始扫描', 'Scan again', '重新扫描'], '.scan-toolbar button');
  }
  const summary = await waitFor('new completed scan', async () => {
    const value = await call('summary');
    if (value?.state === 'error') throw new Error(value.message || 'Fixture scan failed.');
    return value?.state === 'completed' && value.scanId !== previous?.scanId ? value : false;
  });
  await waitUI('scan location rendered', targetPath => document.querySelector('.scan-location')?.title === targetPath, target);
  await settle();
  return summary;
}
async function enableVisibility() {
  for (const index of [0, 1]) {
    await waitUI('display filter available', i => {
      const input = document.querySelectorAll('.view-filters input[type="checkbox"]')[i];
      if (!input || input.disabled) return false;
      if (!input.checked) input.click(); return true;
    }, index);
    await waitUI('display filter enabled', i => document.querySelectorAll('.view-filters input[type="checkbox"]')[i]?.checked, index);
  }
}
async function selectOnly(filePath) {
  await clickButton(['文件树', 'File tree'], '.sidebar button');
  await enableVisibility();
  await waitUI('file tree settled', () => document.querySelector('[role="treegrid"]')?.getAttribute('aria-busy') === 'false' && !document.querySelector('.fx-search input')?.disabled);
  await settle();
  await waitUI('select fixture', target => {
    const row = [...document.querySelectorAll('.fx-filename')].find(node => node.title === target)?.closest('[role="row"]');
    const input = row?.querySelector('input');
    if (!input || input.disabled) return false;
    for (const other of document.querySelectorAll('[role="treegrid"] input[type="checkbox"]:checked')) if (other !== input) other.click();
    if (!input.checked) input.click(); return true;
  }, filePath);
  await settle();
}
async function openReview() {
  const count = report.requests.length;
  await clickButton(['查看 1 项', 'Review 1'], '.explorer-actions button');
  await waitFor('default plan rendered', async () => report.requests.length === count + 1 && (await render(reviewUI))?.checked !== undefined);
  await waitUI('review no longer busy', () => {
    const input = document.querySelector('.review-modal input');
    return !!document.querySelector('.review-modal') && (!input || !input.disabled);
  });
  await settle();
  return report.requests.at(-1);
}
async function toggleHidden(checked, keyboard = false) {
  await waitUI('hidden checkbox focus', expected => {
    const input = document.querySelector('.review-hidden-option input');
    if (!input || input.disabled || input.checked === expected) return false;
    input.focus(); return document.activeElement === input;
  }, checked);
  if (keyboard) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  } else await render(() => document.querySelector('.review-hidden-option input').click());
}
async function expectPlan(allowHidden, eligible) {
  await waitFor('rebuilt plan settled', async () => {
    const ui = await render(reviewUI); const request = report.requests.at(-1);
    return request?.returned && request.allowHidden === allowHidden && request.eligible === eligible
      && ui?.checked === allowHidden && ui.disabled === false && !ui.updating && !ui.error
      && ui.continueDisabled === !eligible ? ui : false;
  });
  await settle();
}
function mark(text) { report.checks.push(text); }
async function closeReview() { await clickButton(['返回', 'Back'], '.review-modal button'); await waitUI('review closed', () => !document.querySelector('.review-modal')); }

async function execute() {
  await waitUI('production API and initial UI', () => !!window.diskharbor && !!document.querySelector('.scan-toolbar'));
  const prefs = window.webContents.getLastWebPreferences();
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
  window.setContentSize(1024, 700); window.show(); app.focus(); window.focus(); await settle();
  await scan(root); await selectOnly(hiddenFile);
  const first = await openReview();
  assert.equal(first.options.allowHidden, false); assert.equal(first.allowHidden, false); assert.equal(first.hiddenReviewAvailable, true); assert.equal(first.eligible, 0);
  let ui = await render(reviewUI);
  assert.equal(ui.checked, false); assert.equal(ui.continueDisabled, true); assert.ok(ui.blocked);
  mark('Default review visibly blocks the ordinary hidden fixture, leaves opt-in unchecked, and explains an actionable route.');

  const originalPlan = first.planId;
  nextResponse = 'hold';
  await toggleHidden(true, true);
  await waitFor('real IPC response held', () => heldResponse && releaseResponse);
  ui = await render(reviewUI);
  assert.equal(ui.checked, true); assert.equal(ui.disabled, true); assert.equal(ui.continueDisabled, true); assert.equal(ui.updating, true);
  assert.equal(executions, 0); releaseResponse(); releaseResponse = undefined;
  await expectPlan(true, 1);
  assert.notEqual(report.requests.at(-1).planId, originalPlan);
  assert.deepEqual(report.requests.at(-1).ids, first.ids);
  assert.equal((await render(reviewUI)).focusedCheckbox, true);
  mark('Keyboard Space rebuilds a distinct plan from the same selection; pending review blocks execution, then restores checkbox focus.');

  nextResponse = 'reject'; await toggleHidden(false);
  await waitUI('failed replacement stays in modal', () => !!document.querySelector('.review-rebuild-error'));
  ui = await render(reviewUI); assert.equal(ui.checked, false); assert.equal(ui.continueDisabled, true); assert.equal(ui.disabled, false);
  assert.equal(executions, 0);
  await clickButton(['重新核对清单', 'Review the list again'], '.review-modal button');
  await expectPlan(false, 0);
  assert.equal(report.requests.at(-1).options.allowHidden, false);
  assert.equal((await render(reviewUI)).focusedCheckbox, true);
  mark('A rejected replacement disables the previously eligible plan; visible retry uses the requested false option and restores protection.');

  await toggleHidden(true); await expectPlan(true, 1); await closeReview();
  const reopened = await openReview(); assert.equal(reopened.options.allowHidden, false);
  ui = await render(reviewUI); assert.equal(ui.checked, false); assert.equal(ui.continueDisabled, true);
  mark('Closing and reopening review resets this one-plan permission to false.');

  for (const language of ['zh-CN', 'en']) {
    if (language === 'en') {
      await closeReview(); await clickButton(['EN'], '.language-button'); await openReview();
    }
    ui = await render(reviewUI);
    assert.ok(ui.scrollWidth <= ui.width + 1); assert.equal(ui.overflowY, 'auto');
    report[language] = ui;
    await render(() => document.querySelector('.review-hidden-option input').focus());
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await settle();
    assert.equal(await render(() => document.querySelector('.review-modal').contains(document.activeElement)), true);
    await fs.writeFile(path.join(base, `review-${language}.png`), (await window.webContents.capturePage()).toPNG());
  }
  mark('At 1024×700, Chinese and English explanations fit horizontally; the review scrolls and keyboard Tab remains inside the modal.');

  heldResponse = undefined; nextResponse = 'hold'; await toggleHidden(true);
  await waitFor('old scan review held', () => heldResponse && releaseResponse);
  const old = heldResponse;
  await scan(otherRoot, true);
  await waitUI('scan replacement closes review', () => !document.querySelector('.review-modal'));
  releaseResponse(); releaseResponse = undefined;
  await waitFor('old response delivered', () => old.returned); await settle();
  assert.equal(await render(reviewUI), null);
  assert.equal(await render(() => document.querySelectorAll('.fx-row input:checked').length), 0);
  assert.equal(executions, 0);
  await scan(root); await selectOnly(hiddenFile); await openReview();
  assert.equal((await render(reviewUI)).checked, false);
  mark('A new scan closes review and clears selection; a late eligible old-scan response cannot reopen it or carry opt-in to the next review.');

  await closeReview(); await selectOnly(protectedFile); const protectedPlan = await openReview();
  assert.equal(protectedPlan.hiddenReviewAvailable, false); assert.equal(protectedPlan.allowHidden, false); assert.equal(protectedPlan.eligible, 0);
  ui = await render(reviewUI); assert.equal(ui.checked, null); assert.equal(ui.continueDisabled, true); assert.ok(ui.blocked);
  const forced = await call('planCleanup', protectedPlan.ids, { allowHidden: true });
  assert.equal(forced.items.filter(item => item.eligible).length, 0);
  assert.deepEqual(await call('history'), []);
  mark(process.platform === 'win32' ? 'A genuine +S +H fixture stays blocked without an opt-in toggle, including a direct allowHidden request.' : 'A genuine dot-configuration fixture stays blocked without an opt-in toggle, including a direct allowHidden request.');

  await closeReview(); await selectOnly(hiddenFile); await openReview(); await toggleHidden(true); await expectPlan(true, 1);
  await clickButton(['继续并由系统确认', 'Continue to confirmation'], '.review-modal button');
  await waitFor('native confirmation cancelled', () => report.confirmations.length === 1);
  await waitUI('review closes after execution request', () => !document.querySelector('.review-modal'));
  await waitFor('cleanup no longer active', async () => {
    const status = await call('cleanupStatus'); return !status || ['completed', 'cancelled', 'failed'].includes(status.state);
  });
  assert.equal(executions, 1); assert.equal(trashCalls, 0);
  assert.equal(await fs.readFile(hiddenFile, 'utf8'), 'ordinary hidden fixture\n');
  assert.equal(await fs.readFile(protectedFile, 'utf8'), 'protected fixture\n');
  const history = await call('history');
  assert.equal(history.length, 1); assert.equal(history[0].state, 'cancelled');
  assert.equal(history[0].success, 0); assert.equal(history[0].spaceMeasurement.status, 'not-run');
  assert.ok(history[0].items.every(item => item.status === 'cancelled'));
  report.cancelledRecord = history[0];
  assert.deepEqual(report.errors, []);
  mark('The opt-in still reaches native final confirmation; cancelling keeps both files byte-for-byte and records cancellation with no measurements, zero successes and zero Trash calls.');
}

async function finish(error) {
  if (finishing) return;
  finishing = true; clearTimeout(watchdog); releaseResponse?.();
  ipcMain.handle = originalHandle; shell.trashItem = originalTrash; dialog.showMessageBox = originalDialog;
  report.trashCalls = trashCalls; report.executions = executions; report.result = error ? 'failed' : 'passed';
  if (error) {
    report.error = String(error.stack || error);
    if (window && !window.isDestroyed()) {
      report.ui = await render(reviewUI).catch(() => null);
      report.page = await render(() => document.body.innerText).catch(() => null);
      await fs.writeFile(path.join(base, 'failure.png'), (await window.webContents.capturePage()).toPNG()).catch(() => {});
    }
  }
  await fs.writeFile(path.join(base, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); app.exit(error ? 1 : 0);
}

try {
  for (const directory of [root, otherRoot, userData]) fsSync.mkdirSync(directory, { recursive: true });
  fsSync.writeFileSync(hiddenFile, 'ordinary hidden fixture\n');
  fsSync.writeFileSync(protectedFile, 'protected fixture\n');
  fsSync.writeFileSync(path.join(otherRoot, 'replacement.txt'), 'new scan fixture\n');
  if (process.platform === 'win32') {
    execFileSync('attrib.exe', ['+H', hiddenFile]);
    execFileSync('attrib.exe', ['+S', '+H', protectedFile]);
  }
  app.on('browser-window-created', (_event, created) => {
    if (window) return; window = created;
    window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') report.errors.push(details.message); });
    window.webContents.once('did-finish-load', () => execute().then(() => finish(), finish));
  });
  require('../electron/main.cjs');
} catch (error) { void finish(error); }
