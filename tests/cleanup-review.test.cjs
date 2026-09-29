'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// Render the production component without a browser or a second UI copy.
// Real modal focus and async plan replacement require desktop checks.
const modules = new Map();
function loadSource(filename) {
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const localRequire = specifier => {
    if (!specifier.startsWith('.')) return require(specifier);
    if (specifier.endsWith('.css')) return {};
    const base = path.resolve(path.dirname(filename), specifier);
    const resolved = [base, `${base}.ts`, `${base}.tsx`].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!resolved) throw new Error(`Missing UI source: ${specifier}`);
    return loadSource(resolved);
  };
  new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
  return module.exports;
}
const { CleanupReview } = loadSource(path.resolve(__dirname, '../src/components/CleanupPanels.tsx'));
function render(planChanges = {}, props = {}) {
  const plan = { id: 'review-1', allowHidden: false, hiddenReviewAvailable: true,
    items: [{ id: 2, path: 'C:\\fixture\\private.txt', kind: 'file', size: 42,
      eligible: false, reason: 'HIDDEN_PATH' }],
    totalBytes: 0, omittedCount: 0, createdAt: 0, expiresAt: 120000, ...planChanges };
  return renderToStaticMarkup(React.createElement(CleanupReview, {
    plan, locale: 'en', formatSize: value => `${value} B`, busy: false,
    onClose() {}, onExecute() {}, onReviewHidden() {}, ...props,
  }));
}
const checkbox = html => html.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0];
const continueButton = html => html.match(/<button\b[^>]*class="button primary"[^>]*>/)?.[0];

test('ordinary hidden review is explicitly offered but unchecked and cannot silently execute', () => {
  const html = render();
  assert.ok(checkbox(html));
  assert.doesNotMatch(checkbox(html), /\bchecked=/);
  assert.match(html, /Allow ordinary hidden items for this cleanup/);
  assert.match(html, /System, application-data and dot-prefixed paths stay protected/);
  assert.match(html, /No items are currently eligible/);
  assert.match(continueButton(html), /disabled=""/);
  assert.match(continueButton(html), /aria-describedby="review-blocked-help"/);
});

test('approved hidden choice remains revocable when the backend has no further hidden recommendation', () => {
  const html = render({ allowHidden: true, hiddenReviewAvailable: false,
    items: [{ id: 2, path: 'C:\\fixture\\private.txt', kind: 'file', size: 42, eligible: true }], totalBytes: 42 });
  assert.match(checkbox(html), /checked=""/);
  assert.doesNotMatch(continueButton(html), /disabled=/);
  assert.match(html, /final system confirmation still apply/);
});

test('protected-only plans do not suggest a hidden override and explain the unavailable action', () => {
  const html = render({ hiddenReviewAvailable: false,
    items: [{ id: 2, path: 'C:\\fixture\\.config', kind: 'directory', size: 42, eligible: false, reason: 'HIDDEN_PATH' }] });
  assert.equal(checkbox(html), undefined);
  assert.match(continueButton(html), /disabled=""/);
  assert.match(html, /Check the reasons in the list and go back to change the selection/);
});

test('updating a review disables the hidden choice and continuation with a visible status', () => {
  const html = render({}, { busy: true });
  assert.match(checkbox(html), /disabled=""/);
  assert.match(continueButton(html), /disabled=""/);
  assert.match(html, /role="status">Reviewing the list again/);
});

test('a failed replacement blocks even an old eligible plan and offers a retry inside the modal', () => {
  const html = render({ items: [{ id: 2, path: 'C:\\fixture\\private.txt', kind: 'file', size: 42, eligible: true }] },
    { reviewError: 'SCAN_CHANGED' });
  assert.match(continueButton(html), /disabled=""/);
  assert.match(html, /role="alert"/);
  assert.match(html, /The list could not be updated/);
  assert.match(html, /Review the list again/);
});

test('Chinese review exposes the same opt-in and retained protection boundaries', () => {
  const html = render({}, { locale: 'zh-CN' });
  assert.match(html, /允许本次回收普通隐藏项目/);
  assert.match(html, /系统、应用数据和点号路径仍受保护/);
  assert.match(html, /关闭清单后不保留此选项/);
  assert.match(html, /隐藏项目或配置路径受到保护。/);
  assert.doesNotMatch(checkbox(html), /\bchecked=/);
});

test('preload forwards the explicit plan option while execution accepts no hidden override', async () => {
  let api;
  const calls = [];
  const electron = { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'diskharbor'); api = value; } },
    ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve(); } } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require(name) { assert.equal(name, 'electron'); return electron; },
  });
  await api.planCleanup([2], { allowHidden: true });
  await api.planCleanup([2], { allowHidden: false });
  await api.planCleanup([2]);
  await api.executeCleanup('approved-plan', 'en', { allowHidden: true });
  assert.deepEqual(calls, [
    ['diskharbor:planCleanup', [2], { allowHidden: true }],
    ['diskharbor:planCleanup', [2], { allowHidden: false }],
    ['diskharbor:planCleanup', [2], undefined],
    ['diskharbor:executeCleanup', 'approved-plan', 'en'],
  ]);
});
