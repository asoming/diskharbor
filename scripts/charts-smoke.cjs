'use strict';
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const fixture = path.join(project, 'output', `charts-smoke-${randomUUID()}`);
fs.mkdirSync(fixture, { recursive: true });
const env = { ...process.env, DISKHARBOR_CHART_SMOKE_DIR: fixture,
  XDG_DATA_HOME: path.join(fixture, 'xdg-data'), XDG_CACHE_HOME: path.join(fixture, 'xdg-cache') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.DISKHARBOR_DEV_URL;
const child = spawn(require('electron'), [path.join(project, 'tests/charts-smoke.cjs')], { cwd: project, env, stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
