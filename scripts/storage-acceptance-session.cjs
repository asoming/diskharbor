'use strict';

// This helper is entered only by storage-acceptance's private dbus-run-session.
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { fixtureIdentity } = require('./storage-acceptance-support.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  if (process.platform !== 'linux') throw new Error('Storage acceptance requires Linux.');
  const project = path.resolve(__dirname, '..');
  const fixture = process.env.DISKHARBOR_STORAGE_DIR;
  if (!fixture || path.dirname(fixture) !== path.join(project, 'output')
      || !/^storage-acceptance-[0-9a-f-]+$/.test(path.basename(fixture))) {
    throw new Error('Missing owned storage fixture.');
  }
  const expected = JSON.parse(fs.readFileSync(path.join(fixture, 'bootstrap.json'), 'utf8'));
  if (JSON.stringify(fixtureIdentity(fixture)) !== JSON.stringify(expected.fixtureIdentity)) {
    throw new Error('Owned fixture identity changed before starting the private session.');
  }
  const address = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!address?.startsWith(`${expected.listen},`) || address === expected.originalBus
      || process.env.HOME !== expected.originalHome) {
    throw new Error('Private bus or unchanged HOME could not be verified.');
  }
  const directories = {
    XDG_DATA_HOME: 'xdg-data', XDG_CACHE_HOME: 'xdg-cache',
    XDG_CONFIG_HOME: 'xdg-config', XDG_RUNTIME_DIR: 'xdg-runtime',
  };
  for (const [key, folder] of Object.entries(directories)) {
    const target = path.join(fixture, folder);
    if (process.env[key] !== target || fs.realpathSync(target) !== target
        || (fs.statSync(target).mode & 0o777) !== 0o700) {
      throw new Error(`Isolated ${key} could not be verified.`);
    }
  }
  const binary = ['/usr/libexec/gvfsd', '/usr/lib/gvfs/gvfsd'].find(candidate => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
  });
  if (!binary) throw new Error('gvfsd is unavailable; install gvfs-daemons.');
  const log = fs.openSync(path.join(fixture, 'gvfsd.log'), 'w', 0o600);
  const daemon = spawn(binary, ['--no-fuse'], { env: process.env, stdio: ['ignore', log, log] });
  let daemonError = null;
  daemon.on('error', error => { daemonError = error; });
  let electron = null;
  let stopping = false;
  const stop = () => {
    stopping = true;
    if (electron && electron.exitCode === null) electron.kill('SIGTERM');
    if (daemon.exitCode === null) daemon.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    let ownerPid = null;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !stopping) {
      if (daemonError) throw daemonError;
      if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error('Private gvfsd exited before readiness.');
      try {
        const { stdout } = await execute('gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus',
          '--object-path', '/org/freedesktop/DBus', '--method',
          'org.freedesktop.DBus.GetConnectionUnixProcessID', 'org.gtk.vfs.Daemon'], { timeout: 2000 });
        ownerPid = Number(/uint32 (\d+)/.exec(stdout)?.[1]);
        if (ownerPid) break;
      } catch (error) {
        if (error.code === 'ENOENT') throw error;
      }
      await delay(50);
    }
    if (ownerPid !== daemon.pid) throw new Error('Private gvfsd PID does not match its bus owner.');
    const daemonEnv = Object.fromEntries(fs.readFileSync(`/proc/${ownerPid}/environ`, 'utf8')
      .split('\0').filter(value => value.includes('=')).map(value => {
        const split = value.indexOf('=');
        return [value.slice(0, split), value.slice(split + 1)];
      }));
    for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'HOME', ...Object.keys(directories)]) {
      if (daemonEnv[key] !== process.env[key]) throw new Error(`Private gvfsd ${key} differs from the test session.`);
    }
    const { stdout: gioVersion } = await execute('gio', ['version'], { timeout: 2000 });
    const { stdout: gvfsVersion } = await execute(binary, ['--version'], { timeout: 2000 });
    const isolation = {
      platform: process.platform, privateBus: true, busAddress: address,
      daemonPid: ownerPid, daemonPidMatchesBusOwner: true, daemonEnvironmentVerified: true,
      homeUnchanged: true, customBusHasNoServiceDirs: true, fuseDisabled: true,
      xdgDataHome: process.env.XDG_DATA_HOME, xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
      xdgConfigHome: process.env.XDG_CONFIG_HOME, xdgCacheHome: process.env.XDG_CACHE_HOME,
      gioVersion: gioVersion.trim(), gvfsVersion: gvfsVersion.trim(),
      guiRestoreVerified: false,
    };
    fs.writeFileSync(path.join(fixture, 'isolation.json'), JSON.stringify(isolation, null, 2) + '\n');
    // The private daemon mounts its Trash backend lazily when the test queries
    // its first verified owned item; this launcher never lists trash:///.
    electron = spawn(require('electron'), [path.join(project, 'tests', 'storage-acceptance.cjs')], {
      cwd: project, env: process.env, stdio: 'inherit',
    });
    const code = await new Promise((resolve, reject) => {
      electron.once('error', reject);
      electron.once('exit', value => resolve(value ?? 1));
    });
    if (stopping || code !== 0) throw new Error(`Storage acceptance exited with ${code}.`);
  } finally {
    stop();
    if (daemon.exitCode === null && daemon.signalCode === null) {
      await Promise.race([new Promise(resolve => daemon.once('exit', resolve)), delay(1000)]);
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    }
    fs.closeSync(log);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
