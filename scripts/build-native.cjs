'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// Compile for the exact Electron runtime. N-API 8 also permits the same addon
// to load in Node's test runner; Windows keeps node-gyp's delay-load hook.
if (!['win32', 'darwin'].includes(process.platform)) {
  console.log('Native policy is not needed on Linux; preview uses verified mount metadata.');
  process.exit(0);
}
const root = path.resolve(__dirname, '..');
const electronVersion = require(path.join(root, 'node_modules/electron/package.json')).version;
const source = path.join(root, 'electron/native-src');
const output = path.join(root, 'electron/native', `${process.platform}-${process.arch}`);
const devdir = process.env.DISKHARBOR_NATIVE_HEADERS || path.join(os.tmpdir(), 'diskharbor-electron-headers');
const result = spawnSync(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild',
  `--target=${electronVersion}`, `--arch=${process.arch}`, '--dist-url=https://electronjs.org/headers', `--devdir=${devdir}`],
{ cwd: source, stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.join(source, 'build/Release/file_policy.node'), path.join(output, 'file-policy.node'));
const executable = process.platform === 'win32' ? 'file_probe.exe' : 'file_probe';
const destination = path.join(output, process.platform === 'win32' ? 'file-probe.exe' : 'file-probe');
fs.copyFileSync(path.join(source, 'build/Release', executable), destination);
if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
const policy = require(path.join(output, 'file-policy.node'));
if (policy.install() !== true) throw new Error('NATIVE_POLICY_UNAVAILABLE');
console.log(`Built native policy and probe for ${process.platform}-${process.arch}, Electron ${electronVersion}.`);
