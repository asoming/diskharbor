'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWindowsPermissions } = require('../electron/windows-permissions.cjs');
const { nativePaths } = require('../electron/native-metadata.cjs');

const nonce = '0123456789abcdef0123456789abcdef';
const flag = `--diskharbor-elevated-restart=1234:${nonce}`;
function fixture(overrides = {}) {
  const calls = [];
  let controller;
  const app = {
    releaseSingleInstanceLock: () => calls.push(['release', controller.restarting]),
    requestSingleInstanceLock: () => { calls.push(['acquire']); return true; },
    quit: () => calls.push(['quit', controller.restarting]),
    ...overrides.app,
  };
  const policy = {
    elevationStatus: () => false,
    restartElevated: async (...args) => { calls.push(['launch', args]); return false; },
    cancelElevatedRestart: () => { calls.push(['cancel-handoff']); return true; },
    waitForRestartParent: (...args) => { calls.push(['resume', ...args]); return true; },
    ...overrides.policy,
  };
  controller = createWindowsPermissions({
    platform: overrides.platform ?? 'win32', packaged: overrides.packaged ?? true,
    app, load: () => policy,
    installPolicy: overrides.installPolicy || (() => { calls.push(['install-policy']); return true; }),
  });
  return { controller, calls, policy };
}

test('Windows permission status is explicit and unavailable outside a known packaged Windows token', () => {
  const normal = fixture().controller;
  assert.deepEqual(normal.state(), { elevated: false, canRequestElevation: true });
  for (const platform of ['linux', 'darwin']) assert.deepEqual(fixture({ platform }).controller.state(), { elevated: null, canRequestElevation: false });
  assert.deepEqual(fixture({ packaged: false }).controller.state(), { elevated: false, canRequestElevation: false });
  assert.deepEqual(fixture({ policy: { elevationStatus: () => true } }).controller.state(), { elevated: true, canRequestElevation: false });
  for (const value of [null, undefined, 0, 1, 'false']) assert.deepEqual(fixture({ policy: { elevationStatus: () => value } }).controller.state(), { elevated: null, canRequestElevation: false });
  assert.deepEqual(fixture({ policy: { elevationStatus: () => { throw new Error('Unavailable'); } } }).controller.state(), { elevated: null, canRequestElevation: false });
});

test('cancelled UAC keeps the existing lock, window and retry capability', async () => {
  const { controller, calls } = fixture();
  assert.deepEqual(await controller.restart(), { started: false });
  assert.deepEqual(calls, [['launch', []]]);
  assert.equal(controller.pending, false);
  assert.equal(controller.restarting, false);
  assert.equal(controller.state().canRequestElevation, true);
});

test('launch failure, child exit and readiness timeout do not release the original lock', async () => {
  for (const code of ['ELEVATION_FAILED', 'ELEVATION_CHILD_EXITED', 'ELEVATION_READY_TIMEOUT']) {
    const { controller, calls } = fixture({ policy: { restartElevated: async () => { throw new Error(code); } } });
    await assert.rejects(controller.restart(), { message: code });
    assert.deepEqual(calls, []);
    assert.equal(controller.pending, false);
    assert.equal(controller.restarting, false);
  }
  const unexpected = fixture({ policy: { restartElevated: async () => ({ started: true }) } });
  await assert.rejects(unexpected.controller.restart(), /ELEVATION_FAILED/);
  assert.deepEqual(unexpected.calls, []);
});

test('native readiness is required before releasing the lock and pending restart refuses duplicates', async () => {
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const { controller, calls } = fixture({ policy: { restartElevated: (...args) => { calls.push(['launch', args]); return ready; } } });
  const restarting = controller.restart('ignored renderer program', 'ignored renderer command');
  assert.equal(controller.pending, true);
  assert.equal(controller.restarting, false);
  assert.equal(controller.state().canRequestElevation, false);
  assert.deepEqual(calls, [['launch', []]]);
  await assert.rejects(controller.restart(), /ELEVATION_IN_PROGRESS/);
  resolveReady(true);
  assert.deepEqual(await restarting, { started: true });
  assert.deepEqual(calls, [['launch', []], ['release', true], ['quit', true]]);
  assert.equal(controller.pending, true, 'Do not admit another operation while the original process is exiting.');
  assert.equal(controller.restarting, true);
});

test('a synchronous quit failure restores the original lock and resets the restart flags', async () => {
  const { controller, calls } = fixture({
    policy: { restartElevated: async () => true },
    app: { quit: () => { throw new Error('quit failed'); } },
  });
  await assert.rejects(controller.restart(), /quit failed/);
  assert.deepEqual(calls, [['release', true], ['cancel-handoff'], ['acquire']]);
  assert.equal(controller.pending, false);
  assert.equal(controller.restarting, false);
});

test('release failure cancels the ready child; unconfirmed cancellation keeps the close gate locked', async () => {
  const released = fixture({ policy: { restartElevated: async () => true },
    app: { releaseSingleInstanceLock: () => { throw new Error('release failed'); } } });
  await assert.rejects(released.controller.restart(), /release failed/);
  assert.deepEqual(released.calls, [['cancel-handoff']]);
  assert.equal(released.controller.pending, false);
  const unconfirmed = fixture({ policy: { restartElevated: async () => true, cancelElevatedRestart: () => false },
    app: { quit: () => { throw new Error('quit failed'); } } });
  await assert.rejects(unconfirmed.controller.restart(), /ELEVATION_FAILED/);
  assert.deepEqual(unconfirmed.calls, [['release', true], ['acquire']]);
  assert.equal(unconfirmed.controller.pending, true);
  assert.equal(unconfirmed.controller.restarting, false);
  await assert.rejects(unconfirmed.controller.restart(), /ELEVATION_IN_PROGRESS/);
});

test('unsupported, unpackaged, already elevated and unknown tokens cannot invoke native launch', async () => {
  for (const options of [{ platform: 'linux' }, { platform: 'darwin' }, { packaged: false },
    { policy: { elevationStatus: () => true } }, { policy: { elevationStatus: () => null } }]) {
    const { controller, calls } = fixture(options);
    await assert.rejects(controller.restart(), /ELEVATION_UNAVAILABLE/);
    assert.deepEqual(calls, []);
  }
});

test('a verified child installs native policy before signalling ready and waiting for its exact parent', () => {
  const { controller, calls } = fixture({ policy: { elevationStatus: () => true } });
  controller.resume(['app.exe', flag]);
  assert.deepEqual(calls, [['install-policy'], ['resume', 1234, nonce]]);
});

test('failed native policy initialization never signals ready or retires the old instance', () => {
  const { controller, calls } = fixture({
    policy: { elevationStatus: () => true }, installPolicy: () => { throw new Error('NATIVE_POLICY_UNAVAILABLE'); },
  });
  assert.throws(() => controller.resume(['app.exe', flag]), /ELEVATION_RESTART_FAILED/);
  assert.deepEqual(calls, []);
  for (const value of [false, null, undefined]) {
    const failed = fixture({ policy: { elevationStatus: () => true }, installPolicy: () => value });
    assert.throws(() => failed.controller.resume(['app.exe', flag]), /ELEVATION_RESTART_FAILED/);
    assert.deepEqual(failed.calls, []);
  }
});

test('resume validates the complete PID and nonce instead of accepting arbitrary arguments', () => {
  const invalid = [
    '--diskharbor-elevated-restart=1234', '--diskharbor-elevated-restart=0:' + nonce,
    '--diskharbor-elevated-restart=-1:' + nonce, '--diskharbor-elevated-restart=1.5:' + nonce,
    '--diskharbor-elevated-restart=4294967296:' + nonce, '--diskharbor-elevated-restart=1234:' + nonce + '0',
    '--diskharbor-elevated-restart=1234:' + 'z'.repeat(32), flag + ' --other-command',
  ];
  for (const argument of invalid) {
    const { controller, calls } = fixture({ policy: { elevationStatus: () => true } });
    assert.throws(() => controller.resume(['app.exe', argument]), /ELEVATION_RESTART_FAILED/);
    assert.deepEqual(calls, []);
  }
  for (const args of [[flag, flag], null, [1234]]) {
    const { controller, calls } = fixture({ policy: { elevationStatus: () => true } });
    assert.throws(() => controller.resume(args), /ELEVATION_RESTART_FAILED/);
    assert.deepEqual(calls, []);
  }
});

test('resume refuses unverified elevation, wrong platform and failed native parent handshake', () => {
  for (const options of [{}, { platform: 'darwin' }, { packaged: false },
    { policy: { elevationStatus: () => null } }]) {
    const { controller, calls } = fixture(options);
    assert.throws(() => controller.resume([flag]), /ELEVATION_RESTART_FAILED/);
    assert.deepEqual(calls, []);
  }
  const { controller, calls } = fixture({ policy: { elevationStatus: () => true, waitForRestartParent: () => false } });
  assert.throws(() => controller.resume([flag]), /ELEVATION_RESTART_FAILED/);
  assert.deepEqual(calls, [['install-policy']]);
});

test('ordinary launches perform no elevation or restart handoff', () => {
  const { controller, calls } = fixture();
  controller.resume(['app.exe', '--unrelated']);
  assert.deepEqual(calls, []);
});

test('real Windows token state is native and malformed/self-parent handoffs fail without UAC', { skip: process.platform !== 'win32' }, () => {
  const native = require(nativePaths('win32').policy);
  const value = native.elevationStatus();
  assert.equal(typeof value, 'boolean');
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') {
    assert.equal(value, true, 'GitHub-hosted Windows runs with an administrator token and UAC disabled; this is not a consent-dialog test.');
  }
  assert.equal(native.waitForRestartParent(process.pid, nonce), false);
  assert.equal(native.waitForRestartParent(-1, nonce), false);
  assert.equal(native.waitForRestartParent(1, 'not-a-valid-nonce'), false);
  assert.equal(native.cancelElevatedRestart(), true, 'No-op rollback never opens an elevation prompt.');
  if (value) assert.throws(() => native.restartElevated(), /ELEVATION_UNAVAILABLE/);
});
