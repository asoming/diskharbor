'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { nativePaths } = require('../electron/native-metadata.cjs');

// Only this test host creates named events; production gains no test exports.
// Parent and receiver are separate instances of the same Node executable, so
// waitForRestartParent performs its real image-path, token and process checks.
const eventHost = String.raw`
$ErrorActionPreference = 'Stop'
$ready = $null; $cancel = $null
try {
  $newReady = $false; $newCancel = $false
  $ready = [System.Threading.EventWaitHandle]::new($false, [System.Threading.EventResetMode]::ManualReset, 'Local\DiskHarbor.Elevation.__PARENT__.__NONCE__', [ref]$newReady)
  $cancel = [System.Threading.EventWaitHandle]::new($false, [System.Threading.EventResetMode]::ManualReset, 'Local\DiskHarbor.Elevation.Cancel.__PARENT__.__NONCE__', [ref]$newCancel)
  if (!$newReady -or !$newCancel) { throw 'Owned event name collision' }
  [Console]::Out.WriteLine('created'); [Console]::Out.Flush()
  while ($null -ne ($command = [Console]::In.ReadLine())) {
    if ($command -eq 'wait-ready') { [Console]::Out.WriteLine('ready:' + [int]$ready.WaitOne(8000)) }
    elseif ($command -eq 'cancel' -or $command -eq 'cancel-and-exit') {
      if (!$cancel.Set()) { throw 'Cancel failed' }
      [Console]::Out.WriteLine('cancelled'); [Console]::Out.Flush()
      if ($command -eq 'cancel-and-exit') { break }
    }
    elseif ($command -eq 'state') { [Console]::Out.WriteLine('state:' + [int]$ready.WaitOne(0)) }
    elseif ($command -eq 'exit') { break }
    else { throw 'Unknown owned test command' }
    [Console]::Out.Flush()
  }
} finally {
  if ($null -ne $ready) { $ready.Dispose() }
  if ($null -ne $cancel) { $cancel.Dispose() }
}
`;

const parentSource = `
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const script = ${JSON.stringify(eventHost)}.replaceAll('__PARENT__', String(process.pid)).replaceAll('__NONCE__', process.argv[1]);
const host = spawn(process.argv[2], ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
const send = value => { if (process.connected) process.send(value); };
const deadline = setTimeout(() => { process.exitCode = 2; host.kill(); }, 20000);
host.stderr.on('data', bytes => process.stderr.write(bytes));
host.stdin.on('error', error => { send({ error: error.message }); process.exitCode = 2; host.kill(); });
host.once('error', error => { send({ error: error.message }); process.exitCode = 2; });
readline.createInterface({ input: host.stdout }).on('line', line => send({ line }));
host.once('close', code => { clearTimeout(deadline); if (code !== 0) process.exitCode = 2; if (process.connected) process.disconnect(); });
process.on('message', command => {
  if (command === 'abort') { process.exitCode = 2; host.kill(); }
  else if (command === 'finish') host.stdin.end('exit\\n');
  else if (['wait-ready', 'cancel', 'cancel-and-exit', 'state'].includes(command)) host.stdin.write(command + '\\n');
});
process.on('disconnect', () => { if (host.exitCode === null) host.kill(); });
`;

const receiverSource = `
const policy = require(process.argv[1]);
try {
  if (policy.elevationStatus() !== true || policy.install() !== true) throw new Error('Elevated native policy required');
  const result = policy.waitForRestartParent(Number(process.argv[2]), process.argv[3]);
  process.send({ result }, () => process.disconnect());
} catch (error) { process.exitCode = 2; process.send({ error: error.message }, () => process.disconnect()); }
`;

function ownedProcess(t, source, args) {
  const child = spawn(process.execPath, ['-e', source, ...args], {
    shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let stderr = '';
  let ended = false;
  let wake;
  const closed = new Promise(resolve => child.once('close', (code, signal) => { ended = true; wake?.(); resolve({ code, signal }); }));
  child.stdout.resume();
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
  child.on('error', error => { messages.push({ error: error.message }); wake?.(); });
  child.on('message', message => { messages.push(message); wake?.(); });
  const bounded = async (promise, milliseconds = 10000) => {
    let timer;
    try { return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Owned handoff process timed out: ${stderr}`)), milliseconds);
    })]); } finally { clearTimeout(timer); }
  };
  t.after(async () => {
    if (!ended) {
      if (child.connected) child.send('abort', () => {});
      child.kill(); // Only this directly spawned, retained ChildProcess handle.
    }
    await bounded(closed, 5000);
  });
  return {
    child,
    send: command => new Promise((resolve, reject) => child.send(command, error => error ? reject(error) : resolve())),
    async message() {
      await bounded(new Promise((resolve, reject) => {
        wake = () => messages.length ? resolve() : ended ? reject(new Error(`Owned process closed before its message: ${stderr}`)) : undefined;
        wake();
      }));
      wake = null;
      const message = messages.shift();
      assert.equal(message.error, undefined, stderr);
      return message;
    },
    async close() {
      assert.deepEqual(await bounded(closed), { code: 0, signal: null }, stderr);
    },
  };
}

for (const scenario of ['success', 'cancel-after-ready', 'cancel-and-exit', 'late-after-cancel']) {
  test(`real Windows handoff ${scenario} uses owned events without requesting UAC`, {
    skip: process.platform !== 'win32', timeout: 35000,
  }, async t => {
    const policyPath = nativePaths('win32').policy;
    const policy = require(policyPath);
    if (policy.elevationStatus() !== true) {
      if (process.env.GITHUB_ACTIONS === 'true') assert.fail('Hosted Windows handoff regression requires the real elevated CI token.');
      return t.skip('The two-process test needs an already elevated token; it never requests UAC.');
    }
    const nonce = randomUUID().replaceAll('-', '');
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const parent = ownedProcess(t, parentSource, [nonce, powershell]);
    assert.deepEqual(await parent.message(), { line: 'created' });
    if (scenario === 'late-after-cancel') {
      await parent.send('cancel');
      assert.deepEqual(await parent.message(), { line: 'cancelled' });
    }
    const receiver = ownedProcess(t, receiverSource, [policyPath, String(parent.child.pid), nonce]);
    if (scenario !== 'late-after-cancel') {
      await parent.send('wait-ready');
      assert.deepEqual(await parent.message(), { line: 'ready:1' });
    }
    if (scenario === 'success') {
      await parent.send('finish');
      await parent.close();
      assert.deepEqual(await receiver.message(), { result: true });
    } else if (scenario === 'cancel-and-exit') {
      await parent.send('cancel-and-exit');
      assert.deepEqual(await parent.message(), { line: 'cancelled' });
      await parent.close();
      assert.deepEqual(await receiver.message(), { result: false }, 'A cancelled handoff stays rejected when the original process exits immediately afterward.');
    } else {
      if (scenario === 'cancel-after-ready') {
        await parent.send('cancel');
        assert.deepEqual(await parent.message(), { line: 'cancelled' });
      }
      assert.deepEqual(await receiver.message(), { result: false });
      assert.equal(parent.child.exitCode, null, 'Cancellation must reject the child while the original process is still alive.');
      if (scenario === 'late-after-cancel') {
        await parent.send('state');
        assert.deepEqual(await parent.message(), { line: 'state:0' }, 'A late child cannot publish readiness after cancellation.');
      }
      await parent.send('finish');
      await parent.close();
    }
    await receiver.close();
  });
}
