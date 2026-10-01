'use strict';

// Linux-only native storage acceptance. Nothing joins the desktop's session
// bus, and no command targets the user's normal Trash or changes HOME.
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { blocked, prerequisites, fixtureIdentity, sourceSnapshot } = require('./storage-acceptance-support.cjs');
let activeFixture;

async function main() {
  await prerequisites();
  const project = path.resolve(__dirname, '..');
  const output = path.join(project, 'output');
  fs.mkdirSync(output, { recursive: true });
  if (fs.realpathSync(output) !== output || fs.lstatSync(output).isSymbolicLink()) throw new Error('Acceptance output must not traverse a symlink.');
  const fixture = path.join(output, `storage-acceptance-${randomUUID()}`);
  fs.mkdirSync(fixture, { mode: 0o700 });
  activeFixture = fixture;
  const identity = fixtureIdentity(fixture);
  const source = await sourceSnapshot(project);
  fs.writeFileSync(path.join(fixture, 'source-start.json'), JSON.stringify(source, null, 2) + '\n');
  const env = { ...process.env, DISKHARBOR_STORAGE_DIR: fixture };
  for (const [key, folder] of Object.entries({
    XDG_DATA_HOME: 'xdg-data', XDG_CACHE_HOME: 'xdg-cache',
    XDG_CONFIG_HOME: 'xdg-config', XDG_RUNTIME_DIR: 'xdg-runtime',
  })) {
    env[key] = path.join(fixture, folder);
    fs.mkdirSync(env[key], { mode: 0o700 });
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DISKHARBOR_DEV_URL;
  env.GIO_USE_VFS = 'gvfs';
  env.GIO_USE_VOLUME_MONITOR = 'unix';
  // A short abstract address avoids the Unix filesystem-socket path limit.
  const listen = `unix:abstract=diskharbor-storage-${randomUUID()}`;
  const config = path.join(fixture, 'bus.conf');
  fs.writeFileSync(config, `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><keep_umask/><listen>${listen}</listen>
<policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy>
</busconfig>\n`);
  // No standard session include, service directories, or systemd activation.
  // Also keep any incidental system-bus lookup outside the desktop session.
  env.DBUS_SYSTEM_BUS_ADDRESS = `unix:abstract=diskharbor-unused-${randomUUID()}`;
  fs.writeFileSync(path.join(fixture, 'bootstrap.json'), JSON.stringify({
    listen, originalHome: process.env.HOME, originalBus: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,
    mountNamespace: fs.readlinkSync('/proc/self/ns/mnt'),
    fixtureIdentity: identity,
  }, null, 2));

  const child = spawn('dbus-run-session', ['--config-file', config, '--', process.execPath,
    path.join(__dirname, 'storage-acceptance-session.cjs')], {
    cwd: project, env, stdio: 'inherit', detached: true,
  });
  let stopped = false;
  let forcedStop;
  const signalGroup = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const stop = () => {
    stopped = true;
    signalGroup('SIGTERM');
    forcedStop ??= setTimeout(() => signalGroup('SIGKILL'), 1500);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const watchdog = setTimeout(stop, 120000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', value => resolve(value ?? 1));
    });
  } finally {
    clearTimeout(watchdog);
    clearTimeout(forcedStop);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    // The detached process group belongs solely to this launcher. This also
    // terminates private gvfs helper children after the private bus exits.
    signalGroup('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100));
    signalGroup('SIGKILL');
  }
  if (stopped || code !== 0) throw new Error(`Isolated storage session failed (${stopped ? 'stopped or timed out' : code}). Fixture: ${fixture}`);
  const mountTest = spawn('unshare', ['--user', '--map-root-user', '--mount', process.execPath,
    path.join(project, 'tests', 'storage-acceptance-mounts.cjs')], {
    cwd: project, env: { ...process.env, DISKHARBOR_STORAGE_DIR: fixture }, stdio: 'inherit', timeout: 30000,
  });
  const mountCode = await new Promise((resolve, reject) => {
    mountTest.once('error', reject);
    mountTest.once('exit', value => resolve(value ?? 1));
  });
  if (mountCode !== 0) {
    const mountReport = fs.existsSync(path.join(fixture, 'mount-report.json'))
      ? JSON.parse(fs.readFileSync(path.join(fixture, 'mount-report.json'), 'utf8')) : null;
    if (mountReport?.result === 'blocked') throw blocked(`Private mount capability unavailable. Fixture: ${fixture}`);
    throw new Error(`Private mount acceptance failed (${mountCode}). Fixture: ${fixture}`);
  }
  const reports = ['report.json', 'mount-report.json'].map(name => JSON.parse(fs.readFileSync(path.join(fixture, name), 'utf8')));
  if (reports.some(report => report.result !== 'passed' || report.errors.length)) throw new Error('Storage acceptance report did not pass.');
  for (const [name, hash] of Object.entries(reports[0].runtimeSources)) {
    if (source.files[`electron/${name}`]?.sha256 !== hash) throw new Error(`Runtime source changed after the start snapshot: ${name}`);
  }
  const summary = { result: 'passed', fixture, checks: reports.reduce((total, report) => total + report.checks.length, 0),
    sourceEvidence: { file: 'source-start.json', capturePhase: source.capturePhase, head: source.head, dirty: source.dirty },
    reports: ['report.json', 'mount-report.json'],
    boundaries: reports.map(report => report.boundary),
    userTrashTouched: false, physicalDeviceDisconnectVerified: false, fileManagerGuiRestoreVerified: false };
  fs.writeFileSync(path.join(fixture, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main().catch(error => {
  const reports = activeFixture ? ['report.json', 'mount-report.json'].filter(name => fs.existsSync(path.join(activeFixture, name))) : [];
  const result = { result: error.code === 'STORAGE_ACCEPTANCE_BLOCKED' ? 'blocked' : 'failed',
    fixture: activeFixture ?? null, error: String(error.message), reports,
    ...(activeFixture && fs.existsSync(path.join(activeFixture, 'source-start.json')) ? { sourceEvidence: { file: 'source-start.json' } } : {}),
    checksCompletedBeforeStop: reports.reduce((total, name) => {
      try { return total + JSON.parse(fs.readFileSync(path.join(activeFixture, name), 'utf8')).checks.length; }
      catch { return total; }
    }, 0) };
  if (activeFixture) fs.writeFileSync(path.join(activeFixture, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = result.result === 'blocked' ? 2 : 1;
});
