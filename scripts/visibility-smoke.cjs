'use strict';

// Run after building the production renderer. Linux needs DISPLAY or xvfb-run.
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const fixture = path.join(project, 'output', `visibility-smoke-${randomUUID()}`);
const fixtureHome = path.join(fixture, 'home');
fs.mkdirSync(fixtureHome, { recursive: true });
const env = {
  ...process.env,
  DISKHARBOR_VISIBILITY_SMOKE_DIR: fixture,
  XDG_CACHE_HOME: path.join(fixtureHome, '.cache'),
  XDG_DATA_HOME: path.join(fixture, 'xdg-data'),
  LOCALAPPDATA: path.join(fixtureHome, 'AppData', 'Local'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.DISKHARBOR_DEV_URL;
const child = spawn(require('electron'), [path.join(project, 'tests', 'visibility-smoke.cjs')], {
  cwd: project, env, stdio: 'inherit',
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
