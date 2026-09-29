'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const filename = path.join(__dirname, '../src/components/WindowsPermissions.tsx');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const component = { exports: {} };
new Function('require', 'module', 'exports', compiled)(name => name.endsWith('.css') ? {} : require(name), component, component.exports);
function render(overrides = {}) {
  return renderToStaticMarkup(React.createElement(component.exports.WindowsPermissions, {
    state: { elevated: false, canRequestElevation: true }, summary: null, locale: 'en', locked: false,
    pending: false, onRequest() {}, ...overrides,
  }));
}
test('Windows permission guidance separates access denial, hidden items and occupied files', () => {
  const denied = render({ summary: { state: 'completed', errorDetails: [{ code: 'EACCES' }] } });
  assert.match(denied, /scan results are incomplete/);
  assert.match(denied, /Reopen as administrator/);
  assert.match(denied, /Cancelling keeps this window and its results/);
  assert.match(denied, /Hidden files are separate from access permissions/);
  const occupied = render({ summary: { state: 'completed', errorDetails: [{ code: 'EBUSY' }] } });
  assert.doesNotMatch(occupied, /Some locations denied access/);
});
test('permission requests are unavailable while scanning or pending and absent when already elevated or unknown', () => {
  for (const overrides of [{ pending: true }, { locked: true }, { summary: { state: 'scanning' } }]) {
    assert.match(render(overrides), /<button[^>]+disabled=""/);
  }
  for (const elevated of [true, null]) assert.doesNotMatch(render({ state: { elevated, canRequestElevation: false } }), /<button/);
  const zh = render({ locale: 'zh-CN', state: { elevated: true, canRequestElevation: false } });
  assert.match(zh, /已经使用管理员权限/);
  assert.match(zh, /仍可能导致读取失败/);
});
test('the elevation preload bridge accepts no executable or argument from its caller', async () => {
  let api; const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve(); } } }),
  });
  await api.requestElevation('untrusted.exe', ['untrusted-argument']);
  assert.deepEqual(calls, [['diskharbor:requestElevation']]);
});
