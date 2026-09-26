'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'output', `native-smoke-${randomUUID()}`);
fs.mkdirSync(fixture, { recursive: true });
const env = { ...process.env, DISKHARBOR_SMOKE_DIR: fixture, XDG_DATA_HOME: path.join(fixture, 'xdg-data') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.DISKHARBOR_DEV_URL;
function run(phase) {
  return new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(root, 'tests', 'electron-smoke.cjs')], {
      cwd: root, env: { ...env, DISKHARBOR_SMOKE_PHASE: phase }, stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Native ${phase} phase exited with ${code}.`)));
  });
}
(async () => {
  await run('primary');
  // A genuinely new Electron process reads the same isolated durable journal.
  await run('reload');
})().catch(error => { console.error(error); process.exitCode = 1; });
