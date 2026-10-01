'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prerequisites, fixtureIdentity } = require('../scripts/storage-acceptance-support.cjs');

test('unsupported platforms and absent display are blocked before launching dependencies', async () => {
  const run = async () => assert.fail('Prerequisite subprocess must not start.');
  await assert.rejects(prerequisites({ platform: 'win32', run }), { code: 'STORAGE_ACCEPTANCE_BLOCKED' });
  await assert.rejects(prerequisites({ platform: 'linux', env: {}, run }), { code: 'STORAGE_ACCEPTANCE_BLOCKED' });
});

test('missing or denied user namespaces are blocked rather than passed or product failures', async () => {
  for (const code of ['ENOENT', 'EPERM']) {
    const commands = [];
    await assert.rejects(prerequisites({ platform: 'linux', env: { DISPLAY: ':fixture' }, run: async binary => {
      commands.push(binary);
      if (binary === 'unshare') throw Object.assign(new Error('Synthetic unavailable capability'), { code });
      return { stdout: '', stderr: '' };
    } }), error => error.code === 'STORAGE_ACCEPTANCE_BLOCKED' && error.message.includes('unshare'));
    assert.equal(commands.at(-1), 'unshare');
  }
});

test('fixture identity refuses aliases and writable-by-others directories', { skip: process.platform !== 'linux' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = path.join(root, 'owned');
  fs.mkdirSync(fixture, { mode: 0o700 });
  assert.match(fixtureIdentity(fixture).ino, /^\d+$/);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(fixture, alias);
  assert.throws(() => fixtureIdentity(alias), /identity\/permissions/);
  fs.chmodSync(fixture, 0o777);
  assert.throws(() => fixtureIdentity(fixture), /identity\/permissions/);
});
