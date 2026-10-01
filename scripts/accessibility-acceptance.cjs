'use strict';

// Build first, then run on a Linux desktop with python3-gi/AT-SPI installed.
// This observes the native accessibility bridge, not screen-reader speech.
// Both D-Bus connections are private; the existing desktop bus is never read.
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const inSession = process.argv[2] === '--session';
const base = inSession ? process.argv[3] : path.join(project, 'output', `accessibility-acceptance-${randomUUID()}`);
if (!base || !path.isAbsolute(base) || path.dirname(base) !== path.join(project, 'output') || !path.basename(base).startsWith('accessibility-acceptance-')) throw new Error('INVALID_FIXTURE_ROOT');
if (!inSession) fs.mkdirSync(base, { recursive: false });

function blocked(reason) {
  const report = { result: 'blocked', platform: process.platform, reason, nativeBridge: 'not-observed', manualScreenReader: 'not-performed', checks: [] };
  fs.writeFileSync(path.join(base, 'report.json'), JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 2;
}

async function execute() {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return blocked('A Linux X11 display is required by this acceptance runner. Wayland and other operating systems remain untested.');
  const registryExecutable = '/usr/libexec/at-spi2-registryd';
  if (!fs.existsSync(registryExecutable)) return blocked(`AT-SPI registry is unavailable: ${registryExecutable}`);
  if (!fs.existsSync(path.join(project, 'dist', 'index.html'))) return blocked('Build the production renderer before running this acceptance.');
  const python = process.env.DISKHARBOR_ATSPI_PYTHON || '/usr/bin/python3';
  const probe = spawnSync(python, ['-c', "import gi; gi.require_version('Atspi', '2.0'); from gi.repository import Atspi"], { encoding: 'utf8' });
  if (probe.status !== 0) return blocked('The selected Python does not provide gi.repository.Atspi. No native accessibility assertion was performed.');
  const env = { ...process.env, DISKHARBOR_ACCESSIBILITY_DIR: base, DISKHARBOR_ATSPI_PYTHON: python,
    XDG_CONFIG_HOME: path.join(base, 'xdg-config'), XDG_CACHE_HOME: path.join(base, 'xdg-cache'), XDG_DATA_HOME: path.join(base, 'xdg-data'),
    XDG_RUNTIME_DIR: path.join(base, 'runtime'), GIO_USE_VFS: 'local', GTK_USE_PORTAL: '0' };
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DISKHARBOR_DEV_URL', 'AT_SPI_BUS_ADDRESS', 'NO_AT_BRIDGE', 'SESSION_MANAGER']) delete env[key];
  if (!inSession) {
    // No activation directories: an accessibility check must not launch the
    // desktop's portals, file managers, keyrings or other unrelated services.
    const sessionConfig = path.join(base, 'session-bus.conf');
    fs.writeFileSync(sessionConfig, '<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>');
    const child = spawn('dbus-run-session', [`--config-file=${sessionConfig}`, '--', process.execPath, __filename, '--session', base], { cwd: project, env, stdio: 'inherit' });
    child.once('error', error => blocked(`Unable to start a private session: ${error.message}`));
    child.once('exit', code => { process.exitCode = code ?? 1; });
    return;
  }
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) throw new Error('PRIVATE_SESSION_UNAVAILABLE');
  const address = `unix:abstract=${path.basename(base)}`;
  const config = path.join(base, 'accessibility-bus.conf');
  fs.writeFileSync(config, '<busconfig><type>accessibility</type><listen>unix:tmpdir=/tmp</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>');
  const privateEnv = { ...env, AT_SPI_BUS_ADDRESS: address, DISKHARBOR_PRIVATE_ATSPI: address };
  const bus = spawn('dbus-daemon', [`--config-file=${config}`, `--address=${address}`, '--nofork', '--print-address=1'], { env: privateEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(base, 'atspi-bus.log'));
  bus.stderr.pipe(log);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Private AT-SPI bus did not start.')), 8000);
    bus.once('error', error => { clearTimeout(timer); reject(error); });
    bus.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    bus.once('exit', code => { clearTimeout(timer); reject(new Error(`Private AT-SPI bus exited ${code}.`)); });
  }).catch(error => { bus.kill(); throw error; });
  // Start this registry directly, without --use-gnome-session. It is an owned
  // child, so teardown can stop it rather than leaving an activated daemon.
  const registry = spawn(registryExecutable, [], { env: privateEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  registry.stderr.pipe(log, { end: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Private AT-SPI registry did not start.')), 8000);
    registry.once('error', error => { clearTimeout(timer); reject(error); });
    registry.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    registry.once('exit', code => { clearTimeout(timer); reject(new Error(`Private AT-SPI registry exited ${code}.`)); });
  }).catch(error => { registry.kill(); bus.kill(); throw error; });
  const child = spawn(require('electron'), [path.join(project, 'tests', 'accessibility-acceptance.cjs')], {
    cwd: project, env: privateEnv, stdio: 'inherit',
  });
  const stop = () => { if (child.exitCode === null) child.kill(); if (registry.exitCode === null) registry.kill(); if (bus.exitCode === null) bus.kill(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  child.once('error', error => { stop(); blocked(error.message); });
  child.once('exit', code => { stop(); process.exitCode = code ?? 1; });
}

execute().catch(error => { console.error(error); process.exitCode = 1; });
