'use strict';
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const root = path.join(__dirname, '..');
const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js')], { cwd: root, stdio: 'inherit' });
let electron;
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  vite.kill();
  electron?.kill();
  process.exitCode = code;
}
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (stopping) return;
    const up = await new Promise(resolve => {
      const req = http.get('http://127.0.0.1:5173', res => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
      req.setTimeout(500, () => { req.destroy(); resolve(false); });
    });
    if (up) {
      electron = spawn(require('electron'), [root], { cwd: root, stdio: 'inherit', env: { ...process.env, DISKHARBOR_DEV_URL: 'http://127.0.0.1:5173' } });
      electron.once('exit', code => stop(code || 0));
      electron.once('error', error => { console.error(error); stop(1); });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  console.error('Vite did not start on port 5173.');
  stop(1);
}
vite.once('exit', code => stop(code || 0));
vite.once('error', error => { console.error(error); stop(1); });
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
void ready();
