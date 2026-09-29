'use strict';

// Build first. Linux requires DISPLAY or xvfb-run. The fixture is never deleted.
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const fixture = path.join(project, 'output', `cleanup-review-smoke-${randomUUID()}`);
fs.mkdirSync(fixture, { recursive: true });
const env = { ...process.env, DISKHARBOR_REVIEW_SMOKE_DIR: fixture, XDG_DATA_HOME: path.join(fixture, 'xdg-data') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.DISKHARBOR_DEV_URL;
const child = spawn(require('electron'), [path.join(project, 'tests', 'cleanup-review-smoke.cjs')], { cwd: project, env, stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
