'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { geckodriverRelease } = require('../scripts/install-validation-browser.cjs');
const { download } = require('../scripts/validation-common.cjs');

test('release credentials stay on the fixed API endpoint and never reach archive redirects', async t => {
  const originalFetch = global.fetch;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskharbor-download-'));
  t.after(async () => { global.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); });
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://api.github.com/repos/mozilla/geckodriver/releases/latest') {
      return Response.json({ tag_name: 'fixture', assets: [] });
    }
    if (url === 'https://github.com/mozilla/fixture') {
      return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture' } });
    }
    return new Response('fixture archive');
  };
  assert.equal((await geckodriverRelease('fixture-token')).tag_name, 'fixture');
  await download('https://github.com/mozilla/fixture', path.join(root, 'archive'), ['github.com', 'githubusercontent.com']);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-token');
  assert.equal(calls[0].options.redirect, 'error');
  for (const call of calls.slice(1)) {
    assert.equal(call.options.redirect, 'manual');
    assert.equal(new Headers(call.options.headers).has('authorization'), false);
  }
  global.fetch = async () => new Response(null, { status: 403 });
  await assert.rejects(geckodriverRelease('fixture-token'), { message: 'GECKODRIVER_RELEASE_403' });
});
