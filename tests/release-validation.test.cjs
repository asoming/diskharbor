'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const childProcess = require('node:child_process');
const { requireHostedCI, ownedChild, firefoxProfileRoots, sha256 } = require('../scripts/validation-common.cjs');
const { packageFiles, connectCDP, upgradeHistory, UPGRADE_BASE_SHA, UPGRADE_BASE_VERSION, pngDimensions } = require('../scripts/package-validation.cjs');
const { safeHistoryItem } = require('../electron/history.cjs');
const { snapshot } = require('../scripts/browser-cache-validation.cjs');

test('command results retain stdout and stderr drained after the child exit event', async t => {
  const commonPath = require.resolve('../scripts/validation-common.cjs');
  const originalModule = require.cache[commonPath];
  const originalSpawn = childProcess.spawn;
  for (const code of [0, 7]) {
    let dataEvents = 0; let dataEventsAtExit; let exited = false; let connection;
    let controlledRun;
    const server = net.createServer(socket => {
      connection = socket;
      if (exited) socket.end('release');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(() => { connection?.destroy(); server.close(); });
    // A real descendant inherits stdout/stderr, but can write only when this
    // test observes its parent's exit and releases the loopback gate. This
    // guarantees exit-before-output without sleeps, retries or paused streams.
    try {
      childProcess.spawn = (...args) => {
        const child = originalSpawn(...args);
        child.stdout.on('data', () => { dataEvents++; });
        child.stderr.on('data', () => { dataEvents++; });
        child.once('exit', () => {
          dataEventsAtExit = dataEvents;
          exited = true;
          connection?.end('release');
        });
        return child;
      };
      delete require.cache[commonPath];
      controlledRun = require(commonPath).run;
    } finally {
      childProcess.spawn = originalSpawn;
      require.cache[commonPath] = originalModule;
    }
    const descendant = `const socket=require('node:net').connect(${server.address().port},'127.0.0.1'); socket.once('error',()=>process.exit(2)); socket.once('connect',()=>process.send('ready')); socket.once('data',()=>process.stdout.write('complete-sha\\n',()=>process.stderr.write('complete-diagnostic\\n',()=>process.exit(0))));`;
    const script = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2,'ipc']}); child.once('error',()=>process.exit(2)); child.once('message',()=>process.exit(${code}));`;
    const outcome = await controlledRun(process.execPath, ['-e', script]).then(result => ({ result }), error => ({ error, result: error.result }));
    assert.equal(dataEventsAtExit, 0, 'Both output pipes must still be undrained when exit fires.');
    assert.equal(Boolean(outcome.error), code !== 0);
    assert.equal(outcome.result.code, code);
    assert.equal(outcome.result.stdout, 'complete-sha\n');
    assert.equal(outcome.result.stderr, 'complete-diagnostic\n');
    if (code) assert.match(outcome.error.message, /complete-diagnostic/);
  }
});

test('command spawn errors still reject without waiting for successful close', async () => {
  const { run } = require('../scripts/validation-common.cjs');
  await assert.rejects(run(path.join(os.tmpdir(), 'diskharbor-no-such-command-' + process.pid)), { code: 'ENOENT' });
});

test('command timeout rejects after exit zero when a descendant keeps output open', async t => {
  const commonPath = require.resolve('../scripts/validation-common.cjs');
  const originalModule = require.cache[commonPath];
  const originalSpawn = childProcess.spawn;
  const originalSetTimeout = global.setTimeout;
  let child; let connection; let fireDeadline; let controlledRun;
  const server = net.createServer(socket => { connection = socket; });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { connection?.end(); server.close(); });
  try {
    childProcess.spawn = (...args) => {
      child = originalSpawn(...args);
      // The real child has exited successfully, but its descendant still owns
      // the pipes. Advance only this helper's deadline at that exact boundary.
      child.once('exit', () => fireDeadline());
      return child;
    };
    delete require.cache[commonPath];
    controlledRun = require(commonPath).run;
  } finally {
    childProcess.spawn = originalSpawn;
    require.cache[commonPath] = originalModule;
  }
  const descendant = `const socket=require('node:net').connect(${server.address().port},'127.0.0.1'); socket.once('error',()=>process.exit(2)); socket.once('connect',()=>process.send('ready')); socket.once('end',()=>process.exit(0));`;
  const script = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2,'ipc']}); child.once('error',()=>process.exit(2)); child.once('message',()=>process.exit(0));`;
  let pending;
  try {
    global.setTimeout = (callback, milliseconds, ...args) => {
      fireDeadline = () => callback(...args);
      return originalSetTimeout(callback, milliseconds, ...args);
    };
    pending = controlledRun(process.execPath, ['-e', script], { timeout: 10000, allowFailure: true });
  } finally { global.setTimeout = originalSetTimeout; }
  await assert.rejects(pending, error => {
    assert.equal(child.exitCode, 0);
    assert.equal(error.code, 'ETIMEDOUT');
    assert.equal(error.result.code, 0);
    assert.equal(child.stdin.destroyed, true);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    return true;
  });
});

test('installation validation refuses personal, self-hosted and non-opted-in environments', () => {
  const allowed = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', DISKHARBOR_RELEASE_VALIDATION: '1', RUNNER_TEMP: path.resolve('temp') };
  assert.doesNotThrow(() => requireHostedCI(allowed));
  for (const changed of [{}, { ...allowed, GITHUB_ACTIONS: 'false' }, { ...allowed, RUNNER_ENVIRONMENT: 'self-hosted' }, { ...allowed, DISKHARBOR_RELEASE_VALIDATION: undefined }, { ...allowed, RUNNER_TEMP: 'relative' }]) assert.throws(() => requireHostedCI(changed), /HOSTED_CI_REQUIRED/);
});
test('owned-child fence rejects a parent, sibling and directory itself', () => {
  const root = path.resolve('owned');
  assert.equal(ownedChild(root, path.join(root, 'app', 'file')), path.join(root, 'app', 'file'));
  for (const target of [root, path.dirname(root), path.resolve('owned-neighbor', 'file'), path.join(root, '..', 'escape')]) assert.throws(() => ownedChild(root, target), /OUTSIDE_OWNED_DIRECTORY/);
});
test('artifact selection refuses ambiguous executables and unexpected platform', () => {
  assert.equal(packageFiles(['DiskHarbor Setup.exe', 'latest.yml'], 'win32'), 'DiskHarbor Setup.exe');
  assert.equal(packageFiles(['diskharbor.deb', 'diskharbor.tar.gz'], 'linux'), 'diskharbor.deb');
  assert.equal(packageFiles(['DiskHarbor.dmg'], 'darwin'), 'DiskHarbor.dmg');
  assert.throws(() => packageFiles(['a.exe', 'b.exe'], 'win32'), /AMBIGUOUS/);
  assert.throws(() => packageFiles(['folder/a.exe'], 'win32'), /AMBIGUOUS/);
  assert.throws(() => packageFiles([], 'other'), /UNSUPPORTED_PLATFORM/);
});
test('Firefox expected paths use real platform default root/local separation', () => {
  assert.deepEqual(firefoxProfileRoots('linux', '/home/ci', {}), { root: '/home/ci/.mozilla/firefox', local: '/home/ci/.cache/mozilla/firefox' });
  assert.deepEqual(firefoxProfileRoots('linux', '/home/ci', { XDG_CACHE_HOME: '/cache' }), { root: '/home/ci/.mozilla/firefox', local: '/cache/mozilla/firefox' });
  assert.deepEqual(firefoxProfileRoots('darwin', '/Users/ci', {}), { root: '/Users/ci/Library/Application Support/Firefox/Profiles', local: '/Users/ci/Library/Caches/Firefox/Profiles' });
  assert.deepEqual(firefoxProfileRoots('win32', 'C:\\Users\\ci', { APPDATA: 'C:\\Users\\ci\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\ci\\AppData\\Local' }), { root: 'C:\\Users\\ci\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles', local: 'C:\\Users\\ci\\AppData\\Local\\Mozilla\\Firefox\\Profiles' });
  assert.throws(() => firefoxProfileRoots('win32', 'C:\\Users\\ci', {}), /UNAVAILABLE/);
});
test('packaged app debugging refuses non-loopback and insecure transport changes', async () => {
  await assert.rejects(connectCDP('ws://example.com:9222/devtools/browser/x'), /CDP_MUST_BE_LOOPBACK/);
  await assert.rejects(connectCDP('wss://127.0.0.1:9222/devtools/browser/x'), /CDP_MUST_BE_LOOPBACK/);
});
test('upgrade uses the same published alpha.11 source in CI and validation with an honest cancelled history fixture', async () => {
  assert.equal(UPGRADE_BASE_SHA, '41eab5d9a2c2ddadd5ff71739df63a3197139024');
  assert.equal(UPGRADE_BASE_VERSION, '0.1.0-alpha.11');
  const workflow = await fs.readFile(path.resolve(__dirname, '../.github/workflows/release-validation.yml'), 'utf8');
  assert.equal(workflow.match(/^\s+ref: ([a-f0-9]{40})$/m)?.[1], UPGRADE_BASE_SHA);
  const value = upgradeHistory(path.resolve('owned-fixture'));
  assert.deepEqual(safeHistoryItem(value), value);
  assert.equal(value.success, 0); assert.equal(value.cancelled, 1);
  assert.equal(value.items[0].status, 'cancelled'); assert.equal(value.spaceMeasurement.status, 'not-run');
  assert.match(value.id, /^synthetic-upgrade-/); assert.equal(value.freeSpaceDelta, null);
});
test('icon evidence rejects missing or oversized PNG headers', async () => {
  const icon = await fs.readFile(path.resolve(__dirname, '../assets/icon.png'));
  const dimensions = pngDimensions(icon); assert.ok(dimensions.width > 0 && dimensions.height > 0);
  assert.throws(() => pngDimensions(Buffer.alloc(24)), /INVALID_ICON_PNG/);
  const invalid = Buffer.from(icon); invalid.writeUInt32BE(100000, 16);
  assert.throws(() => pngDimensions(invalid), /INVALID_ICON_DIMENSIONS/);
});
test('owned cache snapshots measure real files, preserve a sentinel and reject links', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diskharbor-release-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'entries')); await fs.writeFile(path.join(root, 'entries', 'payload'), Buffer.alloc(257));
  const sentinel = path.join(root, 'sentinel'); await fs.writeFile(sentinel, 'preserve me'); const before = await sha256(sentinel);
  assert.deepEqual(await snapshot(path.join(root, 'entries')), { files: 1, bytes: 257 });
  assert.deepEqual(await snapshot(path.join(root, 'missing')), { files: 0, bytes: 0 });
  assert.equal(await sha256(sentinel), before);
  if (process.platform !== 'win32') { await fs.symlink(sentinel, path.join(root, 'entries', 'link')); await assert.rejects(snapshot(path.join(root, 'entries')), /UNEXPECTED_PROFILE_SYMLINK/); }
});
