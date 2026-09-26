'use strict';

// Linux-only native restore verification. Nothing joins the desktop's session
// bus, and no command targets the user's normal Trash or changes HOME.
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  if (process.platform !== 'linux') throw new Error('Restore smoke is supported on Linux only.');
  const project = path.resolve(__dirname, '..');
  const fixture = path.join(project, 'output', `restore-smoke-${randomUUID()}`);
  fs.mkdirSync(fixture, { recursive: true, mode: 0o700 });
  const env = { ...process.env, DISKHARBOR_RESTORE_DIR: fixture };
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
  const listen = `unix:abstract=diskharbor-restore-${randomUUID()}`;
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
  }, null, 2));

  const child = spawn('dbus-run-session', ['--config-file', config, '--', process.execPath,
    path.join(__dirname, 'restore-session.cjs')], {
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
  if (stopped || code !== 0) throw new Error(`Isolated restore session failed (${stopped ? 'stopped or timed out' : code}). Fixture: ${fixture}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
