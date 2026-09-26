'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openSystemTrash, MAX_TIMEOUT_MS } = require('../electron/trash-location.cjs');

test('Linux opens only the fixed trash URI through gio without a shell', async () => {
  const calls = [];
  await openSystemTrash({ platform: 'linux', run: async (...args) => { calls.push(args); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'gio');
  assert.deepEqual(calls[0][1], ['open', 'trash:///']);
  assert.equal(calls[0][2].shell, false);
  assert.ok(calls[0][2].timeout > 0 && calls[0][2].timeout <= MAX_TIMEOUT_MS);
});

test('Linux falls back to xdg-open with the same fixed URI and reports complete failure', async () => {
  const calls = [];
  await openSystemTrash({ platform: 'linux', run: async (command, args) => {
    calls.push([command, args]);
    if (command === 'gio') throw Object.assign(new Error('Not installed'), { code: 'ENOENT' });
  } });
  assert.deepEqual(calls, [['gio', ['open', 'trash:///']], ['xdg-open', ['trash:///']]]);
  await assert.rejects(openSystemTrash({ platform: 'linux', run: async () => { throw new Error('Synthetic desktop unavailable'); } }), { code: 'TRASH_OPEN_FAILED' });
});

test('macOS opens the fixed home Trash path and checks Electron openPath error strings', async () => {
  const calls = [];
  await openSystemTrash({ platform: 'darwin', home: '/Users/Synthetic Name', shell: { openPath: async (value) => { calls.push(value); return ''; } } });
  assert.deepEqual(calls, ['/Users/Synthetic Name/.Trash']);
  await assert.rejects(openSystemTrash({ platform: 'darwin', home: '/Users/Synthetic', shell: { openPath: async () => 'Permission denied' } }), { code: 'TRASH_OPEN_FAILED' });
  await assert.rejects(openSystemTrash({ platform: 'darwin', home: 'relative', shell: { openPath: async () => '' } }), { code: 'TRASH_OPEN_FAILED' });
});

test('Windows launches only the Recycle Bin shell folder and accepts Explorer handoff exit 1', async () => {
  const calls = [];
  await openSystemTrash({ platform: 'win32', run: async (...args) => { calls.push(args); } });
  assert.equal(calls[0][0], 'explorer.exe');
  assert.deepEqual(calls[0][1], ['shell:RecycleBinFolder']);
  assert.equal(calls[0][2].shell, false);
  await openSystemTrash({ platform: 'win32', run: async () => { throw Object.assign(new Error('Synthetic Explorer handoff'), { code: 1, killed: false, signal: null }); } });
  await assert.rejects(openSystemTrash({ platform: 'win32', run: async () => { throw Object.assign(new Error('Missing executable'), { code: 'ENOENT' }); } }), { code: 'TRASH_OPEN_FAILED' });
  await assert.rejects(openSystemTrash({ platform: 'win32', run: async () => { throw Object.assign(new Error('Killed'), { code: 1, killed: true }); } }), { code: 'TRASH_OPEN_FAILED' });
});

test('hung launches are bounded and abort only their own child command', async () => {
  let signal;
  const start = Date.now();
  await assert.rejects(openSystemTrash({ platform: 'win32', timeoutMs: 20, run: async (_command, _args, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } }), { code: 'TRASH_OPEN_FAILED' });
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - start < 2000);
});

test('hung macOS openPath calls time out and unsupported platforms launch nothing', async () => {
  await assert.rejects(openSystemTrash({ platform: 'darwin', home: '/Users/Synthetic', timeoutMs: 20, shell: { openPath: async () => new Promise(() => {}) } }), { code: 'TRASH_OPEN_FAILED' });
  let calls = 0;
  await assert.rejects(openSystemTrash({ platform: 'unsupported', run: async () => { calls++; } }), { code: 'TRASH_OPEN_FAILED' });
  assert.equal(calls, 0);
});
